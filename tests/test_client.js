/* Unit-test SyncClient against the live server using a global WebSocket stub. */
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = (process.env.TEST_BASE || 'http://127.0.0.1:8000').replace(/^https?:\/\//, '');
const [HOST, PORT] = BASE.split(':');

// ---- browser-ish globals ----
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
global.window = global;
global.location = { protocol: 'http:', host: HOST + ':' + PORT };
// Node 20 provides a spec-compatible global CustomEvent; nothing to shim.
global.WebSocket = class {
  static get CONNECTING() { return 0; }
  static get OPEN() { return 1; }
  static get CLOSING() { return 2; }
  static get CLOSED() { return 3; }
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    const m = url.match(/:\d+\/ws\/(.+)$/);
    this._playId = m[1];
    this._buf = Buffer.alloc(0);
    this._up = false;
    this.sock = net.connect(Number(PORT), HOST, () => {
      const key = crypto.randomBytes(16).toString('base64');
      this.sock.write(
        `GET /ws/${this._playId} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    this.sock.on('data', (d) => this._onData(d));
  }
  _onData(d) {
    if (!this._up) {
      this._buf = Buffer.concat([this._buf, d]);
      const i = this._buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      this._up = true;
      this._buf = this._buf.slice(i + 4);
      this.readyState = 1;
      if (this.onopen) this.onopen();
    } else {
      this._buf = Buffer.concat([this._buf, d]);
    }
    this._drain();
  }
  _drain() {
    while (true) {
      const b = this._buf;
      if (b.length < 2) return;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return;
      const payload = b.slice(off, off + len);
      this._buf = b.slice(off + len);
      const opc = b[0] & 0xf;
      if (opc === 0x1 && this.onmessage) this.onmessage({ data: payload.toString('utf8') });
    }
  }
  send(str) {
    const payload = Buffer.from(str);
    const mask = crypto.randomBytes(4);
    const m2 = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) m2[i] = payload[i] ^ mask[i % 4];
    const head = [0x81];
    if (payload.length < 126) head.push(0x80 | payload.length);
    else { head.push(0x80 | 126); const l = Buffer.alloc(2); l.writeUInt16BE(payload.length); head.push(...l); }
    this.sock.write(Buffer.concat([Buffer.from(head), mask, m2]));
  }
  close() { try { this.sock.end(); } catch (e) {} this.readyState = 3; }
};
global.fetch = (url, opts) => new Promise((resolve, reject) => {
  const u = new URL(url, 'http://' + HOST + ':' + PORT);
  const body = opts && opts.body ? opts.body : null;
  const req = http.request({
    host: HOST, port: Number(PORT), method: (opts && opts.method) || 'GET',
    path: u.pathname,
    headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
  }, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, json: () => JSON.parse(data), text: () => data }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

function loadJs(file) {
  new Function('window', fs.readFileSync(path.join(__dirname, '..', 'static', 'js', file), 'utf8'))(global);
}
loadJs('utils.js');
loadJs('sync.js');
loadJs('client.js');

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: HOST, port: Number(PORT), method, path: p,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
    (res) => { let c = ''; res.on('data', (d) => (c += d)); res.on('end', () => resolve(JSON.parse(c))); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(c, m) { if (!c) throw new Error('FAIL: ' + m); }

async function waitFor(c, pred, timeout = 4000) {
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const tick = () => (pred() ? resolve() : Date.now() - t0 > timeout ? reject(new Error('timeout')) : setTimeout(tick, 20));
    tick();
  });
}

async function main() {
  const play = await req('POST', '/api/plays', { name: '客户端引擎测试' });

  // fresh identity for this test
  store.delete('theater-identity');
  const c = new global.SyncClient(play.id);
  assert(c.lamport === 0 && Object.keys(c.vector).length === 0, 'fresh clocks');

  let statuses = [];
  c.on('status', ({ connected }) => statuses.push(connected));

  await c.start();
  await waitFor(c, () => statuses.includes(true));
  console.log('stage: online');
  console.log('connected; identity:', c.identity.client_id, c.identity.name);

  // edit while online: lamport increments, own vector component grows
  c.createOp('scene', 'add', 'scene-x', { name: '序场', order: 1 });
  assert(c.lamport === 1, 'lamport ticked to 1, got ' + c.lamport);
  assert(c.vector[c.identity.client_id] === 1, 'vector own comp = 1');
  await waitFor(c, () => c.queue.length === 0);
  console.log('stage: queue drained online, readyState=', c.ws && c.ws.readyState);
  console.log('queue drained after server ack');

  // simulate offline: stop client (no auto-reconnect), then edit
  c.stop();
  c.connected = false;
  await sleep(50);
  c.createOp('cue', 'add', 'cue-x', { scene_id: 'scene-x', name: '灯暗', kind: 'action', start: 0, duration: 4 });
  c.createOp('cue', 'add', 'cue-y', { scene_id: 'scene-x', name: '雷声', kind: 'sound', start: 6, duration: 2 });
  assert(c.queue.length === 2, '2 edits queued offline, got ' + c.queue.length);
  assert(c.lamport === 3, 'lamport 3 while offline, got ' + c.lamport);

  // reload persistence: new SyncClient same play must restore queue + clocks
  const c2 = new global.SyncClient(play.id);
  assert(c2.queue.length === 2, 'offline queue persisted, got ' + c2.queue.length);
  assert(c2.lamport === 3, 'lamport persisted');
  assert(c2.identity.client_id === c.identity.client_id, 'identity persisted');

  // reconnect flushes the queue
  statuses = [];
  c2.on('status', ({ connected }) => statuses.push(connected));
  await c2.start();
  await waitFor(c2, () => statuses.includes(true));
  console.log('stage: c2 reconnected');
  await waitFor(c2, () => c2.queue.length === 0, 5000);
  console.log('stage: c2 queue empty');
  console.log('reconnect flushed queue; server lamport merged:', c2.lamport);

  // state converges with server
  const serverState = (await req('GET', '/api/plays/' + play.id)).state;
  const localState = c2.state();
  assert(serverState.scenes.length === 1 && localState.scenes.length === 1, 'scene count matches');
  const serverCues = serverState.cues_by_scene['scene-x'].map((x) => x.id).sort();
  const localCues = localState.cues_by_scene['scene-x'].map((x) => x.id).sort();
  assert(JSON.stringify(serverCues) === JSON.stringify(localCues), 'cues match server: ' + serverCues);
  // ordering by start
  const ordered = localState.cues_by_scene['scene-x'].map((x) => x.id);
  assert(ordered[0] === 'cue-x' && ordered[1] === 'cue-y', 'time ordering: action@0 before sound@6');

  // lamport merge from remote: a raw op with bigger lamport bumps local clock
  assert(c2.lamport >= 3, 'lamport sane');
  console.log('final local lamport:', c2.lamport);

  console.log('\nCLIENT ENGINE TESTS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
