import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import packageMetadata from '../package.json' with { type: 'json' };
import { createAtelierServer } from '../server.mjs';
import { Y, encodeBase64, decodeBase64, boardFromDoc, objectToShared } from '../dist/shared-model.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1cAAAAASUVORK5CYII=', 'base64');
const seedBoard = () => ({ id: randomUUID(), title: 'Atelier partagé', description: '', objects: [{ id: 'note-one', type: 'note', text: 'Équipe', x: 10, y: 20, width: 200, height: 170, color: '#ffdd88', votes: {} }] });

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-server-test-'));
  const environment = { dataDir, options, instance: null, url: null, sockets: new Set() };
  environment.start = async () => {
    environment.instance = await createAtelierServer({ host: '127.0.0.1', port: 0, dataDir, ...options });
    environment.url = (await environment.instance.start()).url;
  };
  environment.stop = async () => {
    for (const socket of environment.sockets) socket.terminate();
    environment.sockets.clear();
    if (environment.instance) await environment.instance.close();
    environment.instance = null;
  };
  t.after(async () => { await environment.stop(); await rm(dataDir, { recursive: true, force: true }); });
  await environment.start();
  return environment;
}

class Browser {
  constructor(environment) { this.environment = environment; this.cookie = ''; this.user = null; }
  async request(path, { method = 'GET', body, headers = {}, origin = this.environment.url } = {}) {
    const requestHeaders = { ...headers };
    if (this.cookie) requestHeaders.Cookie = this.cookie;
    if (origin !== null) requestHeaders.Origin = origin;
    if (body !== undefined && !Buffer.isBuffer(body)) {
      requestHeaders['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const response = await fetch(this.environment.url + path, { method, body, headers: requestHeaders, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const sessionCookie = response.headers.getSetCookie().find(value => value.startsWith('atelier_')) || response.headers.getSetCookie()[0];
    if (sessionCookie) this.cookie = sessionCookie.split(';')[0];
    const raw = await response.arrayBuffer();
    const text = Buffer.from(raw).toString();
    let data = null;
    try { data = JSON.parse(text); } catch { /* Binary and static responses are inspected as bytes. */ }
    return { status: response.status, headers: response.headers, data, text, bytes: Buffer.from(raw) };
  }
  async become(name) {
    const response = await this.request('/api/session', { method: 'POST', body: { name } });
    assert.ok([200, 201].includes(response.status), response.text);
    assert.ok(response.data.user?.id);
    this.user = response.data.user;
    return this;
  }
  async createBoard(board = seedBoard()) {
    const response = await this.request('/api/boards', { method: 'POST', body: { board } });
    assert.equal(response.status, 201, response.text);
    assert.equal(response.data.role, 'owner');
    assert.ok(response.data.board.id);
    return response.data;
  }
  async invite(boardId, role = 'editor', expiresInDays = 7) {
    const response = await this.request(`/api/boards/${boardId}/invitations`, { method: 'POST', body: { role, expiresInDays } });
    assert.equal(response.status, 201, response.text);
    assert.ok(response.data.token);
    return response.data;
  }
  async joinInvitation(invitation, extra = {}) {
    return this.request('/api/invitations/join', { method: 'POST', body: { token: invitation.token, ...extra } });
  }
  async board(id) {
    const response = await this.request(`/api/boards/${id}`);
    assert.equal(response.status, 200, response.text);
    return response.data;
  }
}

async function participants(t, role = 'editor', options = {}) {
  const environment = await fixture(t, options);
  const owner = await new Browser(environment).become('Alice');
  const other = await new Browser(environment).become('Benoît');
  const initial = await owner.createBoard();
  const invitation = await owner.invite(initial.board.id, role);
  const joined = await other.joinInvitation(invitation);
  assert.equal(joined.status, 200, joined.text);
  assert.equal(joined.data.role, role);
  return { environment, owner, other, initial, boardId: initial.board.id, invitation };
}

class LiveClient {
  constructor(socket, environment) {
    this.socket = socket;
    this.inbox = [];
    this.waiters = new Set();
    environment.sockets.add(socket);
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      for (const waiter of this.waiters) {
        if (waiter.predicate(message)) {
          clearTimeout(waiter.timer); this.waiters.delete(waiter); waiter.resolve(message); return;
        }
      }
      this.inbox.push(message);
    });
    socket.on('close', () => environment.sockets.delete(socket));
    socket.on('error', () => {});
  }
  wait(predicate, label = 'message') {
    const index = this.inbox.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => { this.waiters.delete(waiter); reject(new Error(`Timeout waiting for ${label}; received ${JSON.stringify(this.inbox)}`)); }, 5000);
      this.waiters.add(waiter);
    });
  }
  send(message) { this.socket.send(JSON.stringify(message)); }
  async sync() {
    const message = await this.wait(value => value.type === 'sync', 'initial synchronization');
    assert.ok(message.state);
    assert.ok(message.vector);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decodeBase64(message.state));
    this.doc = doc;
    return message;
  }
  async update(update, id = randomUUID()) {
    this.send({ type: 'update', id, update });
    return this.wait(value => value.id === id && ['ack', 'error'].includes(value.type), `acknowledgement ${id}`);
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve => this.socket.once('close', resolve));
    this.socket.close();
    await closed;
  }
}

async function live(browser, boardId, { origin = browser.environment.url } = {}) {
  const socket = new WebSocket(`${browser.environment.url.replace(/^http/, 'ws')}/api/boards/${boardId}/live`, { headers: { Cookie: browser.cookie, Origin: origin } });
  const client = new LiveClient(socket, browser.environment);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
    socket.once('unexpected-response', (_, response) => { socket.terminate(); reject(new Error(`WebSocket refused: ${response.statusCode}`)); });
  });
  return client;
}

async function refusedLive(browser, boardId, { origin = browser.environment.url } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${browser.environment.url.replace(/^http/, 'ws')}/api/boards/${boardId}/live`, { headers: { Cookie: browser.cookie, Origin: origin } });
    let denial = null, finished = false;
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Unauthorized WebSocket did not reject')); }, 5000);
    socket.on('error', () => {});
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        assert.equal(message.type, 'error', 'An unauthorized connection received project state or presence');
        denial = message.code;
      } catch (error) { finished = true; clearTimeout(timer); socket.terminate(); reject(error); }
    });
    socket.once('close', code => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      try { assert.equal(code, 1008); assert.ok(denial, 'Access denial must be explicit to stop browser reconnection'); resolve(denial); }
      catch (error) { reject(error); }
    });
    socket.once('unexpected-response', (_, response) => { finished = true; clearTimeout(timer); socket.terminate(); resolve(response.statusCode); });
  });
}

function delta(doc, mutate) {
  const vector = Y.encodeStateVector(doc);
  doc.transact(() => mutate(doc));
  return encodeBase64(Y.encodeStateAsUpdate(doc, vector));
}
const note = doc => doc.getMap('objects').get('note-one');
const snapshot = (doc, id) => boardFromDoc(doc, id).objects.find(object => object.id === 'note-one');
function documentFrom(state) { const doc = new Y.Doc(); Y.applyUpdate(doc, decodeBase64(state)); return doc; }

test('Anonymous GET/HEAD health probes read SQLite without creating sessions or leaking project data', async t => {
  const environment = await fixture(t);
  const owner = await new Browser(environment).become('Alice');
  await owner.createBoard();
  const db = new DatabaseSync(join(environment.dataDir, 'atelier.sqlite'));
  t.after(() => db.close());
  const counts = () => ['users', 'sessions', 'boards', 'members'].map(table => db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
  const before = counts();
  const anonymous = new Browser(environment);
  const response = await anonymous.request('/api/health', { origin: null });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { status: 'ok', version: packageMetadata.version });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(response.headers.getSetCookie(), []);
  const head = await anonymous.request('/api/health', { method: 'HEAD', origin: null });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.deepEqual(head.headers.getSetCookie(), []);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const rejected = await anonymous.request('/api/health', { method, origin: null });
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get('allow'), 'GET, HEAD');
    assert.deepEqual(rejected.headers.getSetCookie(), []);
  }
  assert.deepEqual(counts(), before);
  assert.equal((await owner.request('/api/session')).data.version, packageMetadata.version);
});

test('Health returns a generic unavailable response if its SQLite connection fails', async t => {
  const environment = await fixture(t);
  const prepare = DatabaseSync.prototype.prepare;
  try {
    DatabaseSync.prototype.prepare = function () { throw new Error('Internal database location must not leak'); };
    const response = await new Browser(environment).request('/api/health', { origin: null });
    assert.equal(response.status, 503);
    assert.deepEqual(response.data, { status: 'unavailable' });
    assert.deepEqual(response.headers.getSetCookie(), []);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  assert.equal((await new Browser(environment).request('/api/health', { origin: null })).status, 200);
});

test('Guests have separate protected sessions and project directories, without accounts', async t => {
  const environment = await fixture(t);
  const anonymous = new Browser(environment);
  assert.equal((await anonymous.request('/api/session')).data.user, null);
  assert.equal((await anonymous.request('/api/boards')).status, 401);
  const owner = await anonymous.become('Alice');
  const cookie = (await owner.request('/api/session', { method: 'PATCH', body: { name: 'Alice atelier' } }));
  assert.equal(cookie.status, 200);
  assert.equal(cookie.data.user.id, owner.user.id);
  assert.equal(cookie.data.user.name, 'Alice atelier');
  const other = await new Browser(environment).become('Benoît');
  assert.notEqual(other.user.id, owner.user.id);
  const created = await owner.createBoard();
  assert.deepEqual((await other.request('/api/boards')).data.boards, []);
  assert.equal((await owner.request('/api/boards')).data.boards.length, 1);
  assert.equal((await other.request(`/api/boards/${created.board.id}`)).status, 404);
  const response = await new Browser(environment).request('/api/session', { method: 'POST', body: { name: 'Cookie audit' } });
  const setCookie = response.headers.getSetCookie().join(';');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
});

test('Independent concurrent text, geometry and votes merge for both editors; retries are idempotent', async t => {
  const { owner, other, boardId } = await participants(t);
  const a = await live(owner, boardId), b = await live(other, boardId);
  await Promise.all([a.sync(), b.sync()]);
  const updateA = delta(a.doc, doc => { const item = note(doc); item.get('text').insert(0, 'Salut '); item.set('x', 420); item.get('votes').set(owner.user.id, 1); });
  const updateB = delta(b.doc, doc => { const item = note(doc); item.get('text').insert(item.get('text').length, ' !'); item.set('y', 260); item.get('votes').set(other.user.id, 1); });
  const idA = randomUUID();
  const [ackA, ackB] = await Promise.all([a.update(updateA, idA), b.update(updateB)]);
  assert.equal(ackA.type, 'ack'); assert.equal(ackB.type, 'ack');
  const fromB = await a.wait(value => value.type === 'update' && value.update === updateB, 'second editor delta');
  const fromA = await b.wait(value => value.type === 'update' && value.update === updateA, 'first editor delta');
  Y.applyUpdate(a.doc, decodeBase64(fromB.update)); Y.applyUpdate(b.doc, decodeBase64(fromA.update));
  assert.deepEqual(snapshot(a.doc, boardId), snapshot(b.doc, boardId));
  const result = snapshot(a.doc, boardId);
  assert.equal(result.text, 'Salut Équipe !'); assert.equal(result.x, 420); assert.equal(result.y, 260);
  assert.deepEqual(result.votes, { [owner.user.id]: 1, [other.user.id]: 1 });
  const beforeRetry = await owner.board(boardId);
  const retry = await a.update(updateA, idA);
  assert.equal(retry.type, 'ack');
  assert.equal((await owner.board(boardId)).revision, beforeRetry.revision);
  assert.deepEqual((await owner.board(boardId)).board.objects, beforeRetry.board.objects);
});

test('Acknowledged changes and guest memberships survive a real server stop and restart', async t => {
  const { environment, owner, other, boardId } = await participants(t);
  const a = await live(owner, boardId); await a.sync();
  const update = delta(a.doc, doc => { note(doc).get('text').insert(0, 'Durable : '); note(doc).set('x', 999); });
  const ack = await a.update(update);
  assert.equal(ack.type, 'ack'); assert.ok(Number.isInteger(ack.revision));
  await environment.stop(); await environment.start();
  const restored = await other.board(boardId);
  assert.equal(restored.role, 'editor'); assert.equal(restored.revision, ack.revision);
  assert.equal(restored.board.objects[0].text, 'Durable : Équipe'); assert.equal(restored.board.objects[0].x, 999);
  const reconnect = await live(other, boardId); await reconnect.sync();
  assert.equal(snapshot(reconnect.doc, boardId).text, 'Durable : Équipe');
});

test('Editors can add objects and delete a teammate’s object, including its existing votes', async t => {
  const { owner, other, boardId } = await participants(t);
  const a = await live(owner, boardId), b = await live(other, boardId);
  await Promise.all([a.sync(), b.sync()]);
  const vote = delta(a.doc, doc => note(doc).get('votes').set(owner.user.id, 1));
  assert.equal((await a.update(vote)).type, 'ack');
  const broadcast = await b.wait(value => value.type === 'update', 'teammate vote');
  Y.applyUpdate(b.doc, decodeBase64(broadcast.update));
  const replacement = delta(b.doc, doc => {
    doc.getMap('objects').delete('note-one');
    doc.getMap('objects').set('note-two', objectToShared({ type: 'note', text: 'Nouvelle idée', x: -200, y: 50, width: 200, height: 170, votes: {} }));
  });
  assert.equal((await b.update(replacement)).type, 'ack');
  const result = await owner.board(boardId);
  assert.equal(result.board.objects.length, 1);
  assert.equal(result.board.objects[0].id, 'note-two'); assert.equal(result.board.objects[0].text, 'Nouvelle idée');
});

test('A disconnected editor merges offline work with intervening edits and safely replays a lost acknowledgement', async t => {
  const { owner, other, boardId } = await participants(t);
  const a = await live(owner, boardId), b = await live(other, boardId);
  await Promise.all([a.sync(), b.sync()]);
  await b.close();
  delta(b.doc, doc => { note(doc).get('text').insert(note(doc).get('text').length, ' hors ligne'); note(doc).set('y', 777); });
  const onlineUpdate = delta(a.doc, doc => { note(doc).get('text').insert(0, 'En direct : '); note(doc).set('x', 888); });
  assert.equal((await a.update(onlineUpdate)).type, 'ack');
  const reconnect = await live(other, boardId);
  const sync = await reconnect.sync();
  Y.applyUpdate(b.doc, decodeBase64(sync.state));
  const offlineUpdate = encodeBase64(Y.encodeStateAsUpdate(b.doc, decodeBase64(sync.vector)));
  const operationId = randomUUID();
  reconnect.send({ type: 'update', id: operationId, update: offlineUpdate });
  // Another participant observes the committed update, while this client discards its response.
  await a.wait(value => value.type === 'update' && value.update === offlineUpdate, 'offline edit committed');
  reconnect.socket.terminate();
  const committed = await owner.board(boardId);
  const resumed = await live(other, boardId); await resumed.sync();
  assert.equal((await resumed.update(offlineUpdate, operationId)).type, 'ack');
  const result = await other.board(boardId);
  assert.equal(result.revision, committed.revision);
  assert.equal(result.board.objects[0].text, 'En direct : Équipe hors ligne');
  assert.equal(result.board.objects[0].x, 888); assert.equal(result.board.objects[0].y, 777);
  assert.deepEqual(snapshot(resumed.doc, boardId), snapshot(b.doc, boardId));
});

test('Project access is membership-bound and a viewer cannot send document changes', async t => {
  const { environment, owner, other: viewer, boardId } = await participants(t, 'viewer');
  const outsider = await new Browser(environment).become('Sans invitation');
  assert.equal((await outsider.request(`/api/boards/${boardId}`)).status, 404);
  assert.equal(await refusedLive(outsider, boardId), 'FORBIDDEN');
  assert.equal(await refusedLive(new Browser(environment), boardId), 'SESSION_REQUIRED');
  const client = await live(viewer, boardId); await client.sync();
  const before = await owner.board(boardId);
  const invalid = delta(client.doc, doc => note(doc).set('x', 12345));
  const response = await client.update(invalid);
  assert.equal(response.type, 'error');
  assert.deepEqual((await owner.board(boardId)).board.objects, before.board.objects);
  assert.equal((await viewer.request(`/api/boards/${boardId}/invitations`, { method: 'POST', body: { role: 'owner' } })).status, 403);
  assert.equal((await viewer.request(`/api/boards/${boardId}/assets`, { method: 'POST', body: PNG, headers: { 'Content-Type': 'image/png' } })).status, 403);
});

test('Owners can delegate roles and revoke a connected member; the final owner remains protected', async t => {
  const { owner, other, boardId } = await participants(t);
  const route = `/api/boards/${boardId}/members`;
  const members = await owner.request(route);
  assert.equal(members.status, 200); assert.equal(members.data.members.length, 2);
  assert.equal((await owner.request(`${route}/${owner.user.id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await owner.request(`${route}/${owner.user.id}`, { method: 'PATCH', body: { role: 'viewer' } })).status, 409);
  assert.equal((await other.request(`${route}/${owner.user.id}`, { method: 'PATCH', body: { role: 'viewer' } })).status, 403);
  assert.equal((await owner.request(`${route}/${other.user.id}`, { method: 'PATCH', body: { role: 'owner' } })).status, 200);
  assert.equal((await owner.request(`${route}/${owner.user.id}`, { method: 'PATCH', body: { role: 'editor' } })).status, 200);
  assert.equal((await other.request(`${route}/${other.user.id}`, { method: 'DELETE' })).status, 409);
  const a = await live(owner, boardId); await a.sync();
  const closed = new Promise(resolve => a.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  assert.equal((await other.request(`${route}/${owner.user.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await closed).code, 1008);
  assert.equal((await owner.request(`/api/boards/${boardId}`)).status, 404);
  assert.equal(await refusedLive(owner, boardId), 'FORBIDDEN');
});

test('Invitation links have bounded roles and can be revoked before a guest joins', async t => {
  const environment = await fixture(t);
  const owner = await new Browser(environment).become('Alice');
  const visitor = await new Browser(environment).become('Visiteur');
  const initial = await owner.createBoard(), boardId = initial.board.id;
  const readOnly = await owner.invite(boardId, 'viewer', 1);
  assert.ok(Date.parse(readOnly.expiresAt) > Date.now());
  assert.equal((await new Browser(environment).joinInvitation(readOnly)).status, 401);
  const ownerJoins = await owner.joinInvitation(readOnly);
  assert.equal(ownerJoins.status, 200); assert.equal(ownerJoins.data.role, 'owner');
  const joined = await visitor.joinInvitation(readOnly, { role: 'owner', boardId });
  assert.equal(joined.status, 200); assert.equal(joined.data.role, 'viewer');
  const revoked = await owner.invite(boardId);
  assert.equal((await owner.request(`/api/boards/${boardId}/invitations/${revoked.id}`, { method: 'DELETE' })).status, 200);
  const freshGuest = await new Browser(environment).become('Nouveau');
  assert.equal((await freshGuest.joinInvitation(revoked)).status, 404);
  assert.equal((await freshGuest.joinInvitation({ token: 'not-a-valid-invitation' })).status, 404);
  const listing = await owner.request(`/api/boards/${boardId}/invitations`);
  assert.equal(listing.status, 200);
  assert.ok(listing.data.invitations.every(invitation => !Object.hasOwn(invitation, 'token')));
});

test('An invitation stops granting membership after its expiry', async t => {
  let time = Date.now();
  const environment = await fixture(t, { now: () => time });
  const owner = await new Browser(environment).become('Alice');
  const visitor = await new Browser(environment).become('Invité');
  const initial = await owner.createBoard();
  const invitation = await owner.invite(initial.board.id, 'editor', 1);
  time += 2 * 24 * 60 * 60 * 1000;
  assert.equal((await visitor.joinInvitation(invitation)).status, 404);
  assert.deepEqual((await visitor.request('/api/boards')).data.boards, []);
  assert.equal((await visitor.request(`/api/boards/${initial.board.id}`)).status, 404);
});

test('Presence follows the authenticated guest identity, including read-only participants', async t => {
  const { owner, other, boardId } = await participants(t, 'viewer');
  const a = await live(owner, boardId), b = await live(other, boardId);
  await Promise.all([a.sync(), b.sync()]);
  b.send({ type: 'presence', userId: owner.user.id, name: 'Fake Alice', color: '#000000', cursor: { x: 321, y: -123 }, selection: ['note-one'], editing: 'note-one' });
  const presence = await a.wait(value => value.type === 'presence' && value.users.some(user => user.userId === other.user.id && user.cursor?.x === 321), 'authenticated presence');
  const participant = presence.users.find(user => user.userId === other.user.id);
  assert.equal(participant.name, 'Benoît'); assert.equal(participant.color, other.user.color);
  assert.deepEqual(participant.cursor, { x: 321, y: -123 }); assert.deepEqual(participant.selection, ['note-one']);
  assert.ok(presence.users.filter(user => user.cursor?.x === 321).every(user => user.userId === other.user.id));
});

test('Cross-origin HTTP writes and WebSocket connections are rejected', async t => {
  const { owner, boardId } = await participants(t);
  const foreignOrigin = 'https://untrusted.example';
  assert.equal((await owner.request('/api/boards', { method: 'POST', body: { board: seedBoard() }, origin: foreignOrigin })).status, 403);
  assert.equal((await owner.request('/api/session', { method: 'PATCH', body: { name: 'Cross-origin attack' }, origin: foreignOrigin })).status, 403);
  assert.equal(await refusedLive(owner, boardId, { origin: foreignOrigin }), 403);
  assert.equal((await owner.request('/api/session')).data.user.name, 'Alice');
});

test('Uploaded images are signature-checked and restricted to project members; static paths cannot escape dist', async t => {
  const { environment, owner, boardId } = await participants(t);
  const outsider = await new Browser(environment).become('Sans accès');
  await outsider.createBoard();
  const uploaded = await owner.request(`/api/boards/${boardId}/assets`, { method: 'POST', body: PNG, headers: { 'Content-Type': 'image/png' } });
  assert.equal(uploaded.status, 201, uploaded.text); assert.match(uploaded.data.src, /^\/api\/boards\//);
  const image = await owner.request(uploaded.data.src);
  assert.equal(image.status, 200); assert.match(image.headers.get('Content-Type'), /image\/png/);
  assert.deepEqual(image.bytes, PNG);
  assert.equal((await outsider.request(uploaded.data.src)).status, 404);
  assert.equal((await owner.request(`/api/boards/${boardId}/assets`, { method: 'POST', body: Buffer.from('<html>not an image</html>'), headers: { 'Content-Type': 'image/png' } })).status, 415);
  assert.equal((await owner.request(`/api/boards/${boardId}/assets`, { method: 'POST', body: PNG, headers: { 'Content-Type': 'image/jpeg' } })).status, 415);
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
  PNG.copy(oversized);
  assert.equal((await owner.request(`/api/boards/${boardId}/assets`, { method: 'POST', body: oversized, headers: { 'Content-Type': 'image/png' } })).status, 413);
  for (const path of ['/..%2fserver.mjs', '/%2e%2e%2fpackage.json', '/%00index.html']) {
    const response = await owner.request(path);
    assert.ok([400, 403, 404].includes(response.status), `${path} returned ${response.status}`);
    assert.doesNotMatch(response.text, /createAtelierServer|"dependencies"/);
  }
});

test('Malformed shared updates and votes cast as another guest are rejected atomically', async t => {
  const { owner, other, boardId } = await participants(t);
  const client = await live(other, boardId); await client.sync();
  const before = await owner.board(boardId);
  const invalidDoc = documentFrom(before.state);
  const invalid = delta(invalidDoc, doc => { doc.getMap('meta').set('title', 'Should not persist'); doc.getMap('unexpected').set('secret', true); });
  assert.equal((await client.update(invalid)).type, 'error');
  const impersonated = documentFrom(before.state);
  const foreignVote = delta(impersonated, doc => note(doc).get('votes').set(owner.user.id, 1));
  assert.equal((await client.update(foreignVote)).type, 'error');
  const fabricated = documentFrom(before.state);
  const fakeVotes = delta(fabricated, doc => doc.getMap('objects').set('fake-vote-note', objectToShared({ type: 'note', text: 'Fabricated votes', votes: { 'demo-injected': 1 } })));
  assert.equal((await client.update(fakeVotes)).type, 'error');
  const invalidBytes = await client.update('not-base64');
  assert.equal(invalidBytes.type, 'error');
  const after = await owner.board(boardId);
  assert.equal(after.revision, before.revision); assert.deepEqual(after.board, before.board);
  const valid = delta(client.doc, doc => note(doc).get('votes').set(other.user.id, 1));
  assert.equal((await client.update(valid)).type, 'ack');
  assert.equal((await owner.board(boardId)).board.objects[0].votes[other.user.id], 1);
});

test('A failed SQLite commit produces no ACK, broadcast or in-memory change and the same edit can be retried', async t => {
  const { environment, owner, other, boardId } = await participants(t);
  const a = await live(owner, boardId), b = await live(other, boardId);
  await Promise.all([a.sync(), b.sync()]);
  const before = await owner.board(boardId);
  const update = delta(a.doc, doc => note(doc).set('x', 444));
  const operationId = randomUUID();
  const database = new DatabaseSync(join(environment.dataDir, 'atelier.sqlite'));
  t.mock.method(console, 'error', () => {});
  try {
    database.exec("CREATE TRIGGER reject_board_write BEFORE UPDATE ON boards BEGIN SELECT RAISE(FAIL, 'test-write-failure'); END;");
    const response = await a.update(update, operationId);
    assert.equal(response.type, 'error'); assert.equal(response.code, 'SAVE_FAILED');
    const afterFailure = await owner.board(boardId);
    assert.equal(afterFailure.revision, before.revision); assert.deepEqual(afterFailure.board, before.board);
    assert.equal(b.inbox.filter(message => message.type === 'update').length, 0);
    database.exec('DROP TRIGGER reject_board_write;');
    assert.equal((await a.update(update, operationId)).type, 'ack');
    assert.equal((await owner.board(boardId)).board.objects[0].x, 444);
  } finally { database.close(); }
});

test('Undoing a shared note deletion restores the teammate’s existing votes even after a server restart', async t => {
  const { environment, owner, other, boardId } = await participants(t);
  const a = await live(owner, boardId), b = await live(other, boardId);
  await Promise.all([a.sync(), b.sync()]);
  const vote = delta(a.doc, doc => note(doc).get('votes').set(owner.user.id, 1));
  assert.equal((await a.update(vote)).type, 'ack');
  Y.applyUpdate(b.doc, decodeBase64((await b.wait(message => message.type === 'update' && message.update === vote)).update));
  const undo = new Y.UndoManager(b.doc.getMap('objects'));
  try {
    const deletion = delta(b.doc, doc => doc.getMap('objects').delete('note-one'));
    assert.equal((await b.update(deletion)).type, 'ack');
    await environment.stop(); await environment.start();
    const resumed = await live(other, boardId); await resumed.sync();
    const vector = Y.encodeStateVector(b.doc);
    undo.undo();
    const restoration = encodeBase64(Y.encodeStateAsUpdate(b.doc, vector));
    const response = await resumed.update(restoration);
    assert.equal(response.type, 'ack', response.message);
    const restored = (await owner.board(boardId)).board.objects[0];
    assert.equal(restored.text, 'Équipe'); assert.equal(restored.votes[owner.user.id], 1);
  } finally { undo.destroy(); }
});
