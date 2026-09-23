/* End-to-end test against a running server:
 *  - REST create play + ops
 *  - two WebSocket clients with concurrent edits
 *  - one client disconnects, edits "offline", reconnects and flushes
 *  - deterministic convergence; conflict marker for concurrent move/remove
 *  - export/import round trip
 *
 * Server base URL comes from TEST_BASE (default http://127.0.0.1:8000).
 */
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8000';
const [HOST, PORT] = BASE.replace(/^https?:\/\//, '').split(':');
const http = require('http');
const crypto = require('crypto');
const net = require('net');

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: HOST, port: Number(PORT), method, path: urlPath,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
    }, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(chunks), raw: chunks }); }
        catch (e) { resolve({ status: res.statusCode, raw: chunks }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ---- minimal RFC6455 client (text frames, client-masked) ----
class WS {
  constructor(path) {
    this.path = path;
    this.buf = Buffer.alloc(0);
    this.upgraded = false;
    this.queue = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this._ready = resolve;
      this.sock = net.connect(Number(PORT), HOST, () => {
        const key = crypto.randomBytes(16).toString('base64');
        this.sock.write(
          `GET ${this.path} HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      this.sock.on('data', (d) => this._onData(d));
      this.sock.on('error', reject);
    });
  }
  _onData(d) {
    if (!this.upgraded) {
      this.buf = Buffer.concat([this.buf, d]);
      const idx = this.buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const statusLine = this.buf.slice(0, this.buf.indexOf('\r\n')).toString();
      if (!/ 101 /.test(statusLine)) throw new Error('handshake failed: ' + statusLine);
      this.upgraded = true;
      this.buf = this.buf.slice(idx + 4);
      this._ready();
    } else {
      this.buf = Buffer.concat([this.buf, d]);
    }
    this._drainFrames();
  }
  _drainFrames() {
    while (true) {
      const b = this.buf;
      if (b.length < 2) return;
      const opcode = b[0] & 0x0f;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      if (b.length < off + len) return;
      const payload = b.slice(off, off + len);
      this.buf = b.slice(off + len);

      if (opcode === 0x9 || opcode === 0xA) continue;
      if (opcode === 0x8) { this.queue.push({ _close: true }); continue; }
      if (opcode !== 0x1) continue; // only text frames used
      try {
        this.queue.push(JSON.parse(payload.toString('utf8')));
      } catch (e) {
        console.error('bad frame:', payload.toString('utf8').slice(0, 120));
      }
    }
  }
  send(obj) {
    const payload = Buffer.from(JSON.stringify(obj));
    const mask = crypto.randomBytes(4);
    const head = [0x81];
    if (payload.length < 126) head.push(0x80 | payload.length);
    else if (payload.length < 65536) {
      head.push(0x80 | 126);
      const l = Buffer.alloc(2);
      l.writeUInt16BE(payload.length);
      head.push(...l);
    } else throw new Error('frame too large');
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([Buffer.from(head), mask, masked]));
  }
  next(pred, timeoutMs) {
    return new Promise((resolve, reject) => {
      const to = timeoutMs
        ? setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs)
        : null;
      const check = () => {
        const i = this.queue.findIndex((m) => (pred ? pred(m) : true));
        if (i >= 0) {
          const msg = this.queue.splice(i, 1)[0];
          if (to) clearTimeout(to);
          resolve(msg);
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }
  close() { try { this.sock.end(); } catch (e) {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }

async function main() {
  const created = await req('POST', '/api/plays', { name: 'E2E 测试剧目' });
  const playId = created.json.id;
  console.log('play:', playId);

  const a = new WS('/ws/' + playId);
  const b = new WS('/ws/' + playId);
  await a.connect();
  await b.connect();

  a.send({ type: 'hello', client_id: 'clientA', name: '导演', color: '#f00' });
  b.send({ type: 'hello', client_id: 'clientB', name: '音控', color: '#0f0' });
  const wa = await a.next((m) => m.type === 'welcome', 3000);
  const wb = await b.next((m) => m.type === 'welcome', 3000);
  assert(wa.ops.length === 0, 'empty welcome ops');
  await sleep(150);

  const sceneAdd = {
    id: 'clientA:1', client_id: 'clientA', lamport: 1, vector: { clientA: 1 },
    target: 'scene', op: 'add', entity_id: 'scene1', payload: { name: '第一场', order: 1 },
  };
  a.send({ type: 'op', op: sceneAdd });
  const ack1 = await a.next((m) => m.type === 'ack' || m.type === 'error', 3000);
  assert(ack1.type === 'ack' && ack1.inserted, 'A add-scene ack');
  assert((await b.next((m) => m.type === 'op', 3000)).op.id === 'clientA:1', 'B gets scene add');

  const cueAdd = {
    id: 'clientA:2', client_id: 'clientA', lamport: 2, vector: { clientA: 2 },
    target: 'cue', op: 'add', entity_id: 'cue1',
    payload: { scene_id: 'scene1', name: '上场', kind: 'action', start: 0, duration: 5 },
  };
  a.send({ type: 'op', op: cueAdd });
  await a.next((m) => m.type === 'ack', 3000);
  await b.next((m) => m.type === 'op', 3000);

  // B goes offline and (conceptually) queues edits; A concurrently deletes cue1
  b.close();
  await sleep(200);
  const remove = {
    id: 'clientA:3', client_id: 'clientA', lamport: 3, vector: { clientA: 3 },
    target: 'cue', op: 'remove', entity_id: 'cue1', payload: {},
  };
  a.send({ type: 'op', op: remove });
  await a.next((m) => m.type === 'ack', 3000);

  // B reconnects: welcome replays full log; then flush offline queue in batch
  const b2 = new WS('/ws/' + playId);
  await b2.connect();
  b2.send({ type: 'hello', client_id: 'clientB', name: '音控', color: '#0f0', seq: 0 });
  const welcome = await b2.next((m) => m.type === 'welcome', 3000);
  assert(welcome.ops.length === 3, 'welcome replays 3 ops, got ' + welcome.ops.length);
  assert(welcome.presence.some((m) => m.client_id === 'clientA'), 'presence lists A');

  const offlineMove = {
    id: 'clientB:1', client_id: 'clientB', lamport: 4,
    vector: { clientA: 2, clientB: 1 }, // saw add, never saw remove -> concurrent
    target: 'cue', op: 'move', entity_id: 'cue1', payload: { start: 25 },
  };
  const soundAdd = {
    id: 'clientB:2', client_id: 'clientB', lamport: 5,
    vector: { clientA: 2, clientB: 2 },
    target: 'cue', op: 'add', entity_id: 'cue2',
    payload: { scene_id: 'scene1', name: '雷声', kind: 'sound', start: 10, duration: 3 },
  };
  b2.send({ type: 'ops', ops: [offlineMove, soundAdd] });
  const ackBatch = await b2.next((m) => m.type === 'ack_batch', 3000);
  assert(ackBatch.results.length === 2, 'ack_batch 2 results');
  assert(ackBatch.results.every((r) => r.inserted === true), 'both offline ops inserted');

  const o1 = await a.next((m) => m.type === 'op', 3000);
  const o2 = await a.next((m) => m.type === 'op', 3000);
  assert(new Set([o1.op.id, o2.op.id]).size === 2, 'A got two broadcasts');

  await sleep(200);

  // canonical REST state
  const st = (await req('GET', '/api/plays/' + playId)).json.state;
  const cues = st.cues_by_scene.scene1 || [];
  console.log('live cues:', cues.map((c) => c.id + '@' + c.start + ' ' + c.kind));
  console.log('deleted:', st.deleted_cues.map((c) => c.id));
  console.log('conflicts:', Object.keys(st.conflicts));

  assert(!cues.some((c) => c.id === 'cue1'), 'delete must win over concurrent move');
  assert(cues.some((c) => c.id === 'cue2' && c.start === 10), 'offline sound cue present after flush');
  assert(st.conflicts['cue:cue1'], 'conflict cue:cue1 detected');
  assert(st.conflicts['cue:cue1'].winner_op_id === 'clientA:3', 'remove is deterministic winner');

  // deterministic tie-break: a third client makes a concurrent move on cue2
  const c = new WS('/ws/' + playId);
  await c.connect();
  c.send({ type: 'hello', client_id: 'clientC', name: '场记', color: '#00f' });
  await c.next((m) => m.type === 'welcome', 3000);
  const mvB = {
    id: 'clientB:3', client_id: 'clientB', lamport: 6,
    vector: { clientA: 3, clientB: 3 },
    target: 'cue', op: 'move', entity_id: 'cue2', payload: { start: 30 },
  };
  const mvC = {
    id: 'clientC:1', client_id: 'clientC', lamport: 6,
    vector: { clientA: 3, clientB: 2, clientC: 1 }, // concurrent with mvB
    target: 'cue', op: 'move', entity_id: 'cue2', payload: { start: 60 },
  };
  b2.send({ type: 'op', op: mvB });
  c.send({ type: 'op', op: mvC });
  await b2.next((m) => m.type === 'ack', 3000);
  await c.next((m) => m.type === 'ack', 3000);
  await sleep(200);
  const st2d = (await req('GET', '/api/plays/' + playId)).json.state;
  const cue2 = st2d.cues_by_scene.scene1.find((x) => x.id === 'cue2');
  // same lamport 6, total order tie-break client_id: clientB < clientC -> terminal clientC (60)
  assert(cue2.start === 60, 'tie-break winner start=60, got ' + cue2.start);
  assert(st2d.conflicts['cue:cue2'].winner_op_id === 'clientC:1', 'tie-break winner clientC:1');
  console.log('tie-break OK: cue2 @', cue2.start);

  // idempotent duplicate
  b2.send({ type: 'op', op: soundAdd });
  const dupAck = await b2.next((m) => m.type === 'ack', 3000);
  assert(dupAck.inserted === false, 'duplicate op ignored');

  // export / import round trip
  const exported = await req('GET', '/api/plays/' + playId + '/export');
  assert(exported.json.format === 'theater-rehearsal/v1', 'export format');
  assert(Array.isArray(exported.json.ops) && exported.json.ops.length >= 5, 'export carries op log');
  const imported = await req('POST', '/api/plays/import', exported.json);
  assert(imported.json.scene_count === 1, 'imported scene count');
  assert(imported.json.cue_count === 1, 'imported live cue count (only cue2)');
  const impState = (await req('GET', '/api/plays/' + imported.json.play_id)).json.state;
  assert(Object.keys(impState.conflicts).length === 2, 'imported conflicts preserved, got ' + Object.keys(impState.conflicts).length);

  // deleting the scene hides its live cues
  const remScene = {
    id: 'clientA:4', client_id: 'clientA', lamport: 7, vector: { clientA: 4, clientB: 3, clientC: 1 },
    target: 'scene', op: 'remove', entity_id: 'scene1', payload: {},
  };
  a.send({ type: 'op', op: remScene });
  await a.next((m) => m.type === 'ack', 3000);
  await sleep(200);
  const st3 = (await req('GET', '/api/plays/' + playId)).json.state;
  assert(st3.scenes.length === 0, 'scene deleted');
  const liveCount = Object.values(st3.cues_by_scene).reduce((n, l) => n + l.length, 0);
  assert(liveCount === 0, 'cues hidden when their scene is tombstoned');

  // restore cue explicitly (causal restore after seeing remove)
  const restore = {
    id: 'clientA:5', client_id: 'clientA', lamport: 8, vector: { clientA: 5, clientB: 3, clientC: 1 },
    target: 'cue', op: 'restore', entity_id: 'cue2',
    payload: { name: '雷声', kind: 'sound', start: 60, duration: 3, scene_id: 'scene1' },
  };
  a.send({ type: 'op', op: restore });
  await a.next((m) => m.type === 'ack', 3000);
  await sleep(200);
  const st4 = (await req('GET', '/api/plays/' + playId)).json.state;
  assert(!st4.deleted_cues.some((x) => x.id === 'cue2'), 'cue2 revived by explicit restore');

  // REST fallback posting works
  const restOp = {
    id: 'clientA:6', client_id: 'clientA', lamport: 9,
    vector: { clientA: 6, clientB: 3, clientC: 1 },
    target: 'cue', op: 'update', entity_id: 'cue2', payload: { name: '雷声(加强)' },
  };
  const postRes = await req('POST', '/api/plays/' + playId + '/ops', restOp);
  assert(postRes.json.ok, 'REST post ok');

  console.log('\nALL E2E ASSERTIONS PASSED');
  a.close();
  b2.close();
  c.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
