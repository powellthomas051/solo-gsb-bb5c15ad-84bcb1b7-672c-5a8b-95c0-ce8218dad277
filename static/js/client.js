/* Client-side sync engine.
 *
 *  - Lamport clock: local tick on every edit, max-merge on every remote op.
 *  - Version vector: this client's component counts edits; remote components
 *    are merged from incoming vectors.
 *  - Offline edits are persisted in localStorage ("the queue"), tagged with
 *    their lamport + vector, and flushed (possibly batched) on reconnect.
 *  - Every state change is recomputed with Sync.reduceState, so the browser
 *    and server always converge on the same order and conflict set.
 */
(function (global) {
  'use strict';

  class SyncClient extends EventTarget {
    constructor(playId) {
      super();
      this.playId = playId;
      this.identity = this._loadIdentity();
      this.ws = null;
      this.connected = false;
      this.retryMs = 500;
      this.retryTimer = null;
      this.shouldRun = false;

      this.ops = new Map(); // id -> op (durable knowledge base)
      this.lamport = 0;
      this.vector = {}; // clientId -> counter

      this.queueKey = 'queue:' + playId;
      this.opsKey = 'ops:' + playId;
      this.lamportKey = 'lamport:' + playId;
      this.vectorKey = 'vector:' + playId;

      this._loadOps();
    }

    // ---------- identity ----------

    _loadIdentity() {
      let raw = null;
      try {
        raw = JSON.parse(localStorage.getItem('theater-identity') || 'null');
      } catch (e) {
        raw = null;
      }
      if (!raw || !raw.client_id) {
        raw = {
          client_id: U.uid('c'),
          name: '排练者' + Math.floor(Math.random() * 900 + 100),
          color: U.colorFor(raw && raw.client_id || String(Date.now())),
        };
        this._saveIdentity(raw);
      }
      if (!raw.color) raw.color = U.colorFor(raw.client_id);
      return raw;
    }

    _saveIdentity(identity) {
      localStorage.setItem('theater-identity', JSON.stringify(identity));
    }

    setName(name, color) {
      this.identity.name = (name || this.identity.name).slice(0, 60);
      if (color) this.identity.color = color;
      this._saveIdentity(this.identity);
      if (this.connected && this.ws) {
        this._send({ type: 'hello', client_id: this.identity.client_id, name: this.identity.name, color: this.identity.color });
      }
      this.emit('identity');
    }

    // ---------- persistence ----------

    _loadOps() {
      try {
        const raw = JSON.parse(localStorage.getItem(this.opsKey) || '[]');
        for (const op of raw) this._ingestMeta(op, false);
        const l = parseInt(localStorage.getItem(this.lamportKey) || '0', 10);
        if (Number.isFinite(l)) this.lamport = Math.max(this.lamport, l);
        const v = JSON.parse(localStorage.getItem(this.vectorKey) || '{}');
        for (const [k, n] of Object.entries(v)) this.vector[k] = Math.max(this.vector[k] || 0, n | 0);
      } catch (e) {
        /* corrupt cache — start empty */
      }
    }

    _saveOps() {
      try {
        localStorage.setItem(this.opsKey, JSON.stringify([...this.ops.values()]));
        localStorage.setItem(this.lamportKey, String(this.lamport));
        localStorage.setItem(this.vectorKey, JSON.stringify(this.vector));
      } catch (e) {
        /* storage full — still usable in-memory */
      }
    }

    get queue() {
      try {
        return JSON.parse(localStorage.getItem(this.queueKey) || '[]');
      } catch (e) {
        return [];
      }
    }

    set queue(ops) {
      localStorage.setItem(this.queueKey, JSON.stringify(ops));
    }

    // ---------- Lamport / vector ----------

    _mergeLamport(remote) {
      this.lamport = Math.max(this.lamport, int(remote));
    }

    _mergeVector(remote) {
      for (const [k, v] of Object.entries(remote || {})) {
        this.vector[k] = Math.max(this.vector[k] || 0, int(v));
      }
    }

    _ingestMeta(op, persist = true) {
      this._mergeLamport(op.lamport);
      this._mergeVector(op.vector);
      this.ops.set(op.id, op);
      if (persist) this._saveOps();
    }

    _tick() {
      this.lamport += 1;
      const cid = this.identity.client_id;
      this.vector[cid] = (this.vector[cid] || 0) + 1;
      return this.lamport;
    }

    // ---------- public editing API ----------

    createOp(target, kind, entityId, payload) {
      const op = {
        id: this.identity.client_id + ':' + (this._tick()),
        play_id: this.playId,
        client_id: this.identity.client_id,
        lamport: this.lamport,
        vector: Object.assign({}, this.vector),
        target,
        op: kind,
        entity_id: entityId,
        payload: payload || {},
        created_at: new Date().toISOString(),
      };
      this.ops.set(op.id, op);
      this._saveOps();

      const q = this.queue;
      q.push(op);
      this.queue = q;

      this.emit('local-op', { op });
      this.emit('state');

      if (this.connected) {
        this._send({ type: 'op', op });
      }
      this.emit('queue');
      return op;
    }

    state() {
      return Sync.reduceState([...this.ops.values()]);
    }

    // ---------- websocket lifecycle ----------

    async start() {
      this.shouldRun = true;
      // Make sure the server knows this identity (also works as REST fallback).
      try {
        await fetch('/api/members/' + encodeURIComponent(this.identity.client_id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.identity.name, color: this.identity.color }),
        });
      } catch (e) {
        /* offline — queue keeps working */
      }
      this._connect();
    }

    stop() {
      this.shouldRun = false;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      if (this.ws) {
        try { this.ws.close(); } catch (e) {}
      }
    }

    _connect() {
      if (!this.shouldRun) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = proto + '://' + location.host + '/ws/' + this.playId;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        this._scheduleRetry();
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        this._send({
          type: 'hello',
          client_id: this.identity.client_id,
          name: this.identity.name,
          color: this.identity.color,
          seq: 0, // server always sends full play snapshot; dedup by op id
        });
      };

      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (e) {
          return;
        }
        this._onMessage(msg);
      };

      ws.onclose = () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.emit('status', { connected: false });
        if (wasConnected) this.emit('queue');
        this._scheduleRetry();
      };

      ws.onerror = () => {
        try { ws.close(); } catch (e) {}
      };
    }

    _scheduleRetry() {
      if (!this.shouldRun) return;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryMs = Math.min(this.retryMs * 1.4, 5000);
      this.retryTimer = setTimeout(() => {
        this.retryMs = Math.max(500, this.retryMs * 0.8);
        this._connect();
      }, this.retryMs);
    }

    _send(msg) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
        return true;
      }
      return false;
    }

    // ---------- message handling ----------

    _onMessage(msg) {
      switch (msg.type) {
        case 'welcome': {
          this.connected = true;
          this.retryMs = 500;
          let changed = false;
          for (const op of msg.ops || []) {
            if (!this.ops.has(op.id)) {
              this._ingestMeta(op, false);
              changed = true;
            } else {
              this._mergeLamport(op.lamport);
              this._mergeVector(op.vector);
            }
          }
          if (changed) this._saveOps();
          this.emit('presence', { members: msg.presence || [] });
          this.emit('status', { connected: true });
          this._flushQueue();
          if (changed) this.emit('state');
          break;
        }
        case 'op': {
          const op = msg.op;
          if (!this.ops.has(op.id)) {
            this._ingestMeta(op);
            this.emit('remote-op', { op });
            this.emit('state');
          } else {
            this._mergeLamport(op.lamport);
            this._mergeVector(op.vector);
            this._saveOps();
          }
          break;
        }
        case 'ack': {
          this._dropFromQueue(msg.op_id);
          break;
        }
        case 'ack_batch': {
          for (const r of msg.results || []) this._dropFromQueue(r.op_id);
          break;
        }
        case 'presence':
          this.emit('presence', { members: msg.members || [], join: msg.join, leave: msg.leave });
          break;
        case 'imported':
          this.emit('imported', msg);
          break;
        case 'ping':
          this._send({ type: 'ping' });
          break;
        case 'pong':
        case 'error':
          this.emit('server-error', msg);
          break;
      }
    }

    // ---------- offline queue flush on reconnect ----------

    _dropFromQueue(opId) {
      const q = this.queue;
      const next = q.filter((o) => o.id !== opId);
      if (next.length !== q.length) {
        this.queue = next;
        this.emit('queue');
      }
    }

    _flushQueue() {
      const q = this.queue;
      if (q.length === 0) {
        this.emit('queue');
        return;
      }
      // Version-vector merge happens server-side against its durable log:
      // the server stores everything (dedup by op id), and every client —
      // including us on the next snapshot — recomputes the canonical state.
      const sent = this._send({ type: 'ops', ops: q });
      if (!sent) {
        // Socket died mid-handshake; REST fallback.
        this._flushViaRest(q);
      }
    }

    async _flushViaRest(ops) {
      const remaining = [];
      for (const op of ops) {
        try {
          const res = await fetch('/api/plays/' + this.playId + '/ops', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(op),
          });
          if (!res.ok) remaining.push(op);
        } catch (e) {
          remaining.push(op);
        }
      }
      this.queue = remaining;
      this.emit('queue');
    }

    // ---------- events ----------

    on(type, fn) {
      this.addEventListener(type, (e) => fn(e.detail || {}));
    }

    emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail: detail || {} }));
    }
  }

  function int(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }

  global.SyncClient = SyncClient;
})(window);
