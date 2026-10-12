import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { createAtelierServer } from '../server.mjs';
import { Y, encodeBase64, decodeBase64, docFromBoard } from '../dist/shared-model.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1cAAAAASUVORK5CYII=', 'base64');
const seed = (text = 'Équipe') => ({ id: randomUUID(), title: 'Projet quotas', description: '', objects: [{ id: 'note-one', type: 'note', text, x: 10, y: 20, width: 200, height: 170, color: '#ffdd88', votes: {} }] });
const stateBytes = payload => Buffer.from(payload.state, 'base64').length;
const note = doc => doc.getMap('objects').get('note-one');

async function fixture(t, options = {}) {
  const dataDir = await fsPromises.mkdtemp(join(tmpdir(), 'atelier-quotas-test-'));
  const environment = { dataDir, options, instance: null, url: null, sockets: new Set(), beforeStop: new Set() };
  environment.start = async () => {
    environment.instance = await createAtelierServer({ host: '127.0.0.1', port: 0, dataDir, ...environment.options });
    environment.url = (await environment.instance.start()).url;
  };
  environment.stop = async () => {
    for (const release of environment.beforeStop) release();
    for (const socket of environment.sockets) socket.terminate();
    environment.sockets.clear();
    if (environment.instance) await environment.instance.close();
    environment.instance = null;
  };
  environment.restart = async quotas => { await environment.stop(); environment.options.quotas = quotas; await environment.start(); };
  t.after(async () => { await environment.stop(); await fsPromises.rm(dataDir, { recursive: true, force: true }); });
  await environment.start();
  return environment;
}

class Guest {
  constructor(environment, cookie = '') { this.environment = environment; this.cookie = cookie; this.user = null; }
  async request(path, { method = 'GET', body, headers = {}, signal } = {}) {
    const requestHeaders = { Origin: this.environment.url, ...headers };
    if (this.cookie) requestHeaders.Cookie = this.cookie;
    if (body !== undefined && !Buffer.isBuffer(body)) { requestHeaders['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const response = await fetch(this.environment.url + path, { method, body, headers: requestHeaders, signal: signal || AbortSignal.timeout(10000) });
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('atelier_session='));
    if (cookie) this.cookie = cookie.split(';')[0];
    const bytes = Buffer.from(await response.arrayBuffer());
    let data = null;
    try { data = JSON.parse(bytes.toString()); } catch { /* An asset is a binary response. */ }
    return { status: response.status, data, bytes };
  }
  async become(name) {
    const response = await this.request('/api/session', { method: 'POST', body: { name } });
    assert.ok([200, 201].includes(response.status), JSON.stringify(response.data));
    this.user = response.data.user;
    return this;
  }
  async create(board = seed()) {
    const response = await this.request('/api/boards', { method: 'POST', body: { board } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  }
  async board(id) {
    const response = await this.request(`/api/boards/${id}`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  }
  async invite(id, role = 'editor') {
    const response = await this.request(`/api/boards/${id}/invitations`, { method: 'POST', body: { role } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  }
  async join(invitation) {
    const response = await this.request('/api/invitations/join', { method: 'POST', body: { token: invitation.token } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  }
  upload(id, bytes = PNG, options = {}) {
    return this.request(`/api/boards/${id}/assets`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'image/png' }, ...options });
  }
}

class Live {
  constructor(socket, environment) {
    this.socket = socket; this.inbox = []; this.waiters = new Set();
    environment.sockets.add(socket);
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      for (const waiter of this.waiters) {
        if (waiter.predicate(message)) { clearTimeout(waiter.timer); this.waiters.delete(waiter); waiter.resolve(message); return; }
      }
      this.inbox.push(message);
    });
    socket.on('close', () => environment.sockets.delete(socket));
    socket.on('error', () => {});
  }
  wait(predicate) {
    const index = this.inbox.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => { this.waiters.delete(waiter); reject(new Error(`Missing live message; inbox: ${JSON.stringify(this.inbox)}`)); }, 5000);
      this.waiters.add(waiter);
    });
  }
  send(message) { this.socket.send(JSON.stringify(message)); }
  async sync() {
    const message = await this.wait(value => value.type === 'sync');
    this.doc = new Y.Doc(); Y.applyUpdate(this.doc, decodeBase64(message.state));
    return message;
  }
  async update(update, id = randomUUID()) {
    this.send({ type: 'update', id, update });
    return this.wait(value => value.id === id && ['ack', 'error'].includes(value.type));
  }
  async barrier() {
    this.send({ type: 'sync' });
    return this.wait(value => value.type === 'sync');
  }
}

async function live(guest, id) {
  const socket = new WebSocket(`${guest.environment.url.replace(/^http/, 'ws')}/api/boards/${id}/live`, { headers: { Cookie: guest.cookie, Origin: guest.environment.url } });
  const client = new Live(socket, guest.environment);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await client.sync();
  return client;
}

function delta(doc, change) {
  const vector = Y.encodeStateVector(doc);
  doc.transact(() => change(doc));
  return encodeBase64(Y.encodeStateAsUpdate(doc, vector));
}

function quota(response, status = 413) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  assert.equal(response.data?.code, 'QUOTA_EXCEEDED');
}

function database(environment) { return new DatabaseSync(join(environment.dataDir, 'atelier.sqlite')); }
function inspect(environment, fn) { const db = database(environment); try { return fn(db); } finally { db.close(); } }
const usage = environment => inspect(environment, db => db.prepare('SELECT COALESCE(SUM(length(state)),0) AS bytes FROM boards').get().bytes + db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM assets').get().bytes);
const assetFiles = environment => fsPromises.readdir(join(environment.dataDir, 'assets'));

async function eventually(predicate, message = 'Condition did not become true') {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}

async function deadline(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5000); })]); }
  finally { clearTimeout(timer); }
}

// Hold only the durable flush of a temporary uploaded asset. The production
// reservation must already exist before this asynchronous filesystem operation.
function holdAssetFlush(t, environment) {
  const originalOpen = fsPromises.open;
  let release;
  const released = new Promise(resolve => { release = resolve; });
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const mocked = t.mock.method(fsPromises, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (typeof path === 'string' && path.includes('/assets/') && basename(path).endsWith('.tmp')) {
      const originalSync = handle.sync.bind(handle);
      handle.sync = async () => { entered(); await released; return originalSync(); };
    }
    return handle;
  });
  syncBuiltinESMExports();
  let restored = false;
  environment.beforeStop.add(release);
  const restore = () => { release(); environment.beforeStop.delete(release); if (!restored) { restored = true; mocked.mock.restore(); syncBuiltinESMExports(); } };
  t.after(restore);
  return { reached: () => deadline(reached, 'Upload never reached the asset flush'), release, restore };
}

test('Storage quota configuration rejects nonpositive, fractional and unsafe limits', async t => {
  const dataDir = await fsPromises.mkdtemp(join(tmpdir(), 'atelier-quotas-invalid-'));
  t.after(() => fsPromises.rm(dataDir, { recursive: true, force: true }));
  for (const name of ['maxBoardsPerGuest', 'maxBoardBytes', 'maxStorageBytes']) {
    for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '100']) {
      await assert.rejects(() => createAtelierServer({ dataDir, quotas: { [name]: value } }), undefined, `${name} accepted ${String(value)}`);
    }
  }
});

test('Project count stays charged to its creator when ownership changes, and deletion frees that slot', async t => {
  const environment = await fixture(t, { quotas: { maxBoardsPerGuest: 1 } });
  const alice = await new Guest(environment).become('Alice');
  const benoit = await new Guest(environment).become('Benoît');
  const initial = await alice.create(); const id = initial.board.id;
  await benoit.join(await alice.invite(id, 'owner'));
  assert.equal((await benoit.request(`/api/boards/${id}/members/${alice.user.id}`, { method: 'PATCH', body: { role: 'editor' } })).status, 200);
  quota(await alice.request('/api/boards', { method: 'POST', body: { board: seed() } }), 409);
  const own = await benoit.create();
  quota(await benoit.request('/api/boards', { method: 'POST', body: { board: seed() } }), 409);
  assert.equal((await benoit.request(`/api/boards/${id}`, { method: 'DELETE' })).status, 200);
  const replacement = await alice.create();
  assert.notEqual(replacement.board.id, id);
  assert.equal((await benoit.board(own.board.id)).role, 'owner');
});

test('An inline image is charged as Yjs state and a rejected creation leaves no board', async t => {
  const environment = await fixture(t);
  const owner = await new Guest(environment).become('Alice');
  const initial = await owner.create();
  const limit = stateBytes(initial) + PNG.length;
  await environment.restart({ maxBoardBytes: limit });
  const inline = seed();
  inline.objects.push({ id: 'inline-image', type: 'image', src: `data:image/png;base64,${Buffer.concat([PNG, Buffer.alloc(2048)]).toString('base64')}`, x: 30, y: 30, width: 100, height: 100 });
  quota(await owner.request('/api/boards', { method: 'POST', body: { board: inline } }));
  assert.equal((await owner.request('/api/boards')).data.boards.length, 1);
  assert.equal(inspect(environment, db => db.prepare('SELECT count(*) AS count FROM boards').get().count), 1);
  assert.equal((await owner.board(initial.board.id)).state, initial.state);
});

test('A global byte limit covers new projects from other guests, independently of membership', async t => {
  const environment = await fixture(t);
  const owner = await new Guest(environment).become('Alice');
  const other = await new Guest(environment).become('Benoît');
  const initial = await owner.create();
  await environment.restart({ maxStorageBytes: stateBytes(initial) + 1 });
  quota(await other.request('/api/boards', { method: 'POST', body: { board: seed('x'.repeat(2000)) } }));
  assert.deepEqual((await other.request('/api/boards')).data.boards, []);
  const client = await live(owner, initial.board.id);
  const growth = delta(client.doc, doc => note(doc).get('text').insert(0, 'x'.repeat(2000)));
  const rejection = await client.update(growth);
  assert.equal(rejection.type, 'error'); assert.equal(rejection.code, 'QUOTA_EXCEEDED');
  assert.equal((await owner.board(initial.board.id)).state, initial.state);
  assert.equal(usage(environment), stateBytes(initial));
});

test('Rejected live growth is atomic; accepted retries remain idempotent after the bounded update ledger is pruned', async t => {
  const environment = await fixture(t);
  const owner = await new Guest(environment).become('Alice');
  const editor = await new Guest(environment).become('Benoît');
  const initial = await owner.create(); const id = initial.board.id;
  await editor.join(await owner.invite(id));
  await environment.restart({ maxBoardBytes: stateBytes(initial) });
  const a = await live(owner, id), b = await live(editor, id);
  const update = delta(a.doc, doc => note(doc).get('text').insert(0, 'x'.repeat(2000)));
  const operationId = randomUUID();
  const error = await a.update(update, operationId);
  assert.equal(error.type, 'error'); assert.equal(error.code, 'QUOTA_EXCEEDED'); assert.equal(error.id, operationId);
  const [authoritative, peer] = await Promise.all([a.barrier(), b.barrier()]);
  assert.equal(authoritative.state, initial.state); assert.equal(peer.state, initial.state);
  assert.equal(a.inbox.filter(message => message.type === 'ack' && message.id === operationId).length, 0);
  assert.equal(b.inbox.filter(message => message.type === 'update').length, 0);
  const after = await owner.board(id);
  assert.equal(after.revision, initial.revision); assert.equal(after.state, initial.state);
  assert.equal(inspect(environment, db => db.prepare('SELECT count(*) AS count FROM updates').get().count), 0);
  await environment.restart({ maxBoardBytes: stateBytes(initial) + 10000 });
  const retry = await live(owner, id);
  assert.equal((await retry.update(update, operationId)).type, 'ack');
  assert.equal((await owner.board(id)).board.objects[0].text, 'x'.repeat(2000) + 'Équipe');
  const accepted = await owner.board(id);
  inspect(environment, db => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE updates SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', operationId);
      const insert = db.prepare('INSERT INTO updates VALUES(?,?,?,?,?,?)');
      for (let index = 0; index < 1005; index++) insert.run(id, randomUUID(), '0'.repeat(64), owner.user.id, accepted.revision, new Date(Date.UTC(2020, 0, 2) + index).toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  await environment.restart(environment.options.quotas);
  assert.equal(inspect(environment, db => db.prepare('SELECT count(*) AS count FROM updates WHERE board_id=?').get(id).count), 1000);
  assert.equal(inspect(environment, db => db.prepare('SELECT count(*) AS count FROM updates WHERE id=?').get(operationId).count), 0);
  const replay = await live(owner, id);
  assert.equal((await replay.update(encodeBase64(Uint8Array.of(0, 0)))).type, 'ack');
  assert.equal(inspect(environment, db => db.prepare('SELECT count(*) AS count FROM updates WHERE board_id=?').get(id).count), 1000);
  assert.equal((await replay.update(update, operationId)).type, 'ack');
  const replayed = await owner.board(id);
  assert.equal(replayed.revision, accepted.revision); assert.equal(replayed.state, accepted.state);
  assert.equal(inspect(environment, db => db.prepare('SELECT count(*) AS count FROM updates WHERE board_id=?').get(id).count), 1000);
});

test('Concurrent image uploads reserve per-project bytes before filesystem work', async t => {
  const environment = await fixture(t);
  const owner = await new Guest(environment).become('Alice');
  const initial = await owner.create(); const id = initial.board.id;
  const limit = stateBytes(initial) + PNG.length;
  await environment.restart({ maxBoardBytes: limit });
  const results = await Promise.all([owner.upload(id), owner.upload(id)]);
  assert.deepEqual(results.map(response => response.status).sort(), [201, 413]);
  quota(results.find(response => response.status !== 201));
  assert.equal(usage(environment), limit);
  assert.equal((await assetFiles(environment)).length, 1);
  assert.equal(inspect(environment, db => db.prepare('SELECT count(*) AS count FROM assets').get().count), 1);
  assert.equal((await owner.board(id)).revision, initial.revision);
});

test('Concurrent uploads on different projects share the global budget, persist across restart and free space on deletion', async t => {
  const environment = await fixture(t);
  const a = await new Guest(environment).become('Alice');
  const b = await new Guest(environment).become('Benoît');
  const first = await a.create(), second = await b.create();
  const image = Buffer.concat([PNG, Buffer.alloc(4096)]);
  const limit = stateBytes(first) + stateBytes(second) + image.length;
  await environment.restart({ maxStorageBytes: limit });
  const results = await Promise.all([a.upload(first.board.id, image), b.upload(second.board.id, image)]);
  assert.deepEqual(results.map(response => response.status).sort(), [201, 413]);
  assert.equal(usage(environment), limit);
  const winner = results[0].status === 201 ? { guest: a, board: first } : { guest: b, board: second };
  const remaining = results[0].status === 201 ? { guest: b, board: second } : { guest: a, board: first };
  await environment.restart({ maxStorageBytes: limit });
  quota(await remaining.guest.upload(remaining.board.board.id, image));
  const asset = results.find(response => response.status === 201).data.src;
  assert.equal((await winner.guest.request(asset)).status, 200);
  const target = join(environment.dataDir, 'assets', asset.split('/').at(-1));
  const originalRm = fsPromises.rm;
  const deniedRemoval = t.mock.method(fsPromises, 'rm', async (path, ...args) => {
    if (path === target) throw Object.assign(new Error('Test: asset deletion denied'), { code: 'EACCES' });
    return originalRm(path, ...args);
  });
  syncBuiltinESMExports();
  let restored = false;
  const restore = () => { if (!restored) { restored = true; deniedRemoval.mock.restore(); syncBuiltinESMExports(); } };
  t.after(restore);
  assert.equal((await winner.guest.request(`/api/boards/${winner.board.board.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await assetFiles(environment)).length, 1, 'Unremoved bytes must still occupy disk');
  assert.equal(inspect(environment, db => db.prepare('SELECT SUM(size) AS bytes FROM asset_cleanup').get().bytes), image.length);
  quota(await remaining.guest.upload(remaining.board.board.id, image));
  restore();
  await environment.restart({ maxStorageBytes: limit });
  assert.deepEqual(await assetFiles(environment), []);
  assert.equal(inspect(environment, db => db.prepare('SELECT count(*) AS count FROM asset_cleanup').get().count), 0);
  assert.equal((await remaining.guest.upload(remaining.board.board.id, image)).status, 201);
  assert.ok(usage(environment) <= limit);
});

test('An image reservation blocks live growth while its durable file flush is still pending', async t => {
  const environment = await fixture(t);
  const owner = await new Guest(environment).become('Alice');
  const initial = await owner.create(); const id = initial.board.id;
  const image = Buffer.concat([PNG, Buffer.alloc(4096)]);
  await environment.restart({ maxBoardBytes: stateBytes(initial) + image.length });
  const client = await live(owner, id);
  const flush = holdAssetFlush(t, environment);
  const uploading = owner.upload(id, image);
  try {
    await flush.reached();
    const update = delta(client.doc, doc => note(doc).get('text').insert(0, 'x'.repeat(2000)));
    const response = await client.update(update);
    assert.equal(response.type, 'error'); assert.equal(response.code, 'QUOTA_EXCEEDED');
    assert.equal((await owner.board(id)).state, initial.state);
  } finally { flush.release(); }
  assert.equal((await uploading).status, 201);
  assert.equal(usage(environment), stateBytes(initial) + image.length);
});

test('An asset database failure removes temporary and final files and releases its reserved bytes', async t => {
  const environment = await fixture(t);
  const owner = await new Guest(environment).become('Alice');
  const initial = await owner.create(); const id = initial.board.id;
  await environment.restart({ maxBoardBytes: stateBytes(initial) + PNG.length });
  const db = database(environment);
  t.mock.method(console, 'error', () => {});
  try {
    db.exec("CREATE TRIGGER reject_asset BEFORE INSERT ON assets BEGIN SELECT RAISE(FAIL, 'quota-test-write-failure'); END;");
    assert.equal((await owner.upload(id)).status, 503);
    assert.deepEqual(await assetFiles(environment), []);
    assert.equal(usage(environment), stateBytes(initial));
    assert.equal(db.prepare('SELECT count(*) AS count FROM asset_cleanup').get().count, 0);
    db.exec('DROP TRIGGER reject_asset;');
    assert.equal((await owner.upload(id)).status, 201);
    assert.equal(usage(environment), stateBytes(initial) + PNG.length);
  } finally { db.close(); }
});

test('Revocation and cancellation release upload capacity; shutdown waits for an aborted file flush before closing SQLite', async t => {
  const loggedErrors = [];
  t.mock.method(console, 'error', (...values) => loggedErrors.push(values.join(' ')));
  const environment = await fixture(t);
  const owner = await new Guest(environment).become('Alice');
  const editor = await new Guest(environment).become('Benoît');
  const initial = await owner.create(); const id = initial.board.id;
  await editor.join(await owner.invite(id));
  await environment.restart({ maxBoardBytes: stateBytes(initial) + PNG.length });
  const flush = holdAssetFlush(t, environment);
  const uploading = editor.upload(id);
  await flush.reached();
  assert.equal((await owner.request(`/api/boards/${id}/members/${editor.user.id}`, { method: 'DELETE' })).status, 200);
  flush.release();
  assert.equal((await uploading).status, 404);
  assert.deepEqual(await assetFiles(environment), []);
  assert.equal(inspect(environment, db => db.prepare('SELECT count(*) AS count FROM asset_cleanup').get().count), 0);
  flush.restore();

  const cancelledFlush = holdAssetFlush(t, environment);
  const cancellation = new AbortController();
  const closedResponse = new Promise(resolve => environment.instance.server.once('request', (_, response) => response.once('close', resolve)));
  const cancelled = owner.upload(id, PNG, { signal: cancellation.signal }).then(() => assert.fail('Cancelled upload unexpectedly completed'), error => error);
  await cancelledFlush.reached();
  cancellation.abort();
  await cancelled;
  // Let the aborted connection reach the server before its filesystem flush
  // resumes; cleanup remains reserved until removal has actually succeeded.
  await deadline(closedResponse, 'Cancelled response did not close');
  const instance = environment.instance;
  const httpClosed = new Promise(resolve => instance.server.once('close', resolve));
  let shutdownSettled = false;
  const shutdown = instance.close().then(() => { shutdownSettled = true; });
  let secondShutdownSettled = false;
  const secondShutdown = instance.close().then(() => { secondShutdownSettled = true; });
  instance.server.closeAllConnections();
  try {
    await deadline(httpClosed, 'HTTP server did not close after its upload connection was cancelled');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shutdownSettled, false, 'SQLite must remain open until the aborted upload releases its reservation');
    assert.equal(secondShutdownSettled, false, 'Repeated close() must await the same pending filesystem cleanup');
    assert.equal(inspect(environment, db => db.prepare('SELECT count(*) AS count FROM asset_cleanup').get().count), 1);
  } finally { cancelledFlush.release(); }
  await deadline(shutdown, 'Shutdown did not complete after the file flush resumed');
  await deadline(secondShutdown, 'Repeated shutdown did not settle after cleanup');
  environment.instance = null;
  assert.deepEqual(await assetFiles(environment), []);
  assert.equal(inspect(environment, db => db.prepare('SELECT count(*) AS count FROM asset_cleanup').get().count), 0);
  cancelledFlush.restore();
  await environment.start();
  assert.deepEqual(await assetFiles(environment), []);
  assert.equal(inspect(environment, db => db.prepare('SELECT count(*) AS count FROM asset_cleanup').get().count), 0);

  // Abort before the body has arrived completely. This must never consume a
  // reservation or leave a temporary file, even though the headers were valid.
  const receivedBody = new Promise(resolve => environment.instance.server.once('request', request => request.once('data', resolve)));
  const aborted = http.request(`${environment.url}/api/boards/${id}/assets`, { method: 'POST', headers: { Cookie: owner.cookie, Origin: environment.url, 'Content-Type': 'image/png', 'Content-Length': PNG.length + 100 } });
  const abortedDone = new Promise(resolve => { aborted.once('error', resolve); aborted.once('close', resolve); });
  aborted.write(PNG.subarray(0, 24));
  await deadline(receivedBody, 'Partial upload did not reach the server');
  aborted.destroy();
  await abortedDone;
  await eventually(async () => (await assetFiles(environment)).length === 0);
  assert.equal((await owner.upload(id)).status, 201);
  assert.ok(loggedErrors.every(message => message === 'Atelier request failed: aborted'), `Unexpected errors: ${JSON.stringify(loggedErrors)}`);
});

test('Lowering limits preserves existing projects, allows no-op or shrinking live edits and deletion', async t => {
  const environment = await fixture(t);
  const owner = await new Guest(environment).become('Alice');
  const initial = await owner.create(seed('x'.repeat(4000))); const id = initial.board.id;
  const second = await owner.create();
  assert.equal((await owner.upload(id)).status, 201);
  await environment.restart({ maxBoardsPerGuest: 1, maxBoardBytes: 1, maxStorageBytes: 1 });
  const exported = await owner.board(id);
  assert.equal(exported.state, initial.state);
  assert.equal(exported.board.objects[0].text.length, 4000);
  const client = await live(owner, id);
  assert.equal((await client.update(encodeBase64(Uint8Array.of(0, 0)))).type, 'ack');
  const shrinking = delta(client.doc, doc => doc.getMap('objects').delete('note-one'));
  assert.equal((await client.update(shrinking)).type, 'ack');
  assert.ok(stateBytes(await owner.board(id)) < stateBytes(initial));
  quota(await owner.upload(id));
  quota(await owner.request('/api/boards', { method: 'POST', body: { board: seed() } }), 409);
  assert.equal((await owner.request(`/api/boards/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await owner.request(`/api/boards/${second.board.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await assetFiles(environment), []);
  assert.equal(usage(environment), 0);
});

test('An existing V2 database migrates its oldest owner and retains snapshot and asset accounting', async t => {
  const environment = await fixture(t);
  await environment.stop();
  const path = join(environment.dataDir, 'atelier.sqlite');
  await fsPromises.rm(path, { force: true });
  await fsPromises.rm(`${path}-wal`, { force: true });
  await fsPromises.rm(`${path}-shm`, { force: true });
  const db = new DatabaseSync(path);
  const creatorId = randomUUID(), otherId = randomUUID(), boardId = randomUUID(), assetId = randomUUID();
  const creatorToken = randomBytes(32).toString('base64url'), otherToken = randomBytes(32).toString('base64url');
  const digest = value => createHash('sha256').update(value).digest('hex');
  const board = { ...seed(), id: boardId };
  const doc = docFromBoard(board); const state = Buffer.from(Y.encodeStateAsUpdate(doc)); doc.destroy();
  try {
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,color TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
      CREATE TABLE boards(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,state BLOB NOT NULL,revision INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,object_count INTEGER NOT NULL);
      CREATE TABLE members(board_id TEXT NOT NULL REFERENCES boards(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,joined_at TEXT NOT NULL,PRIMARY KEY(board_id,user_id));
      CREATE TABLE assets(id TEXT PRIMARY KEY,board_id TEXT NOT NULL REFERENCES boards(id),mime TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL);`);
    for (const [id, name, token] of [[creatorId, 'Ancien propriétaire', creatorToken], [otherId, 'Nouveau propriétaire', otherToken]]) {
      db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id, name, '#4573C5', '2026-01-01T00:00:00.000Z');
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), id, Date.now() + 86400000);
    }
    db.prepare('INSERT INTO boards VALUES(?,?,?,?,?,?,?)').run(boardId, board.title, board.description, state, 4, '2026-01-01T00:00:00.000Z', board.objects.length);
    db.prepare('INSERT INTO members VALUES(?,?,?,?)').run(boardId, creatorId, 'owner', '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO members VALUES(?,?,?,?)').run(boardId, otherId, 'owner', '2026-01-02T00:00:00.000Z');
    db.prepare('INSERT INTO assets VALUES(?,?,?,?,?)').run(assetId, boardId, 'image/png', PNG.length, '2026-01-01T00:00:00.000Z');
  } finally { db.close(); }
  await fsPromises.writeFile(join(environment.dataDir, 'assets', assetId), PNG);
  environment.options.quotas = { maxBoardsPerGuest: 1, maxBoardBytes: state.length + PNG.length };
  await environment.start();
  const creator = new Guest(environment, `atelier_session=${creatorToken}`);
  const other = new Guest(environment, `atelier_session=${otherToken}`);
  assert.equal((await creator.board(boardId)).revision, 4);
  assert.equal((await creator.board(boardId)).state, state.toString('base64'));
  assert.deepEqual((await other.request(`/api/boards/${boardId}/assets/${assetId}`)).bytes, PNG);
  quota(await creator.request('/api/boards', { method: 'POST', body: { board: seed() } }), 409);
  assert.equal((await other.create()).role, 'owner');
  quota(await creator.upload(boardId));
  assert.equal(usage(environment), inspect(environment, current => current.prepare('SELECT COALESCE(SUM(length(state)),0) AS bytes FROM boards').get().bytes) + PNG.length);
  assert.equal((await other.request(`/api/boards/${boardId}/members/${creatorId}`, { method: 'PATCH', body: { role: 'editor' } })).status, 200);
  await environment.restart(environment.options.quotas);
  quota(await creator.request('/api/boards', { method: 'POST', body: { board: seed() } }), 409);
  assert.equal((await creator.board(boardId)).role, 'editor');
});
