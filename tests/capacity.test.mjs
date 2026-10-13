import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { createAtelierServer } from '../server.mjs';
import { normalizeCapacity, DEFAULT_CAPACITY } from '../server/capacity.mjs';
import { Y, encodeBase64, decodeBase64 } from '../dist/shared-model.js';

async function fixture(t, capacity = {}, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-capacity-'));
  const app = await createAtelierServer({ port: 0, host: '127.0.0.1', dataDir, capacity, ...options });
  const url = (await app.start()).url;
  const sockets = new Set();
  const db = new DatabaseSync(join(dataDir, 'atelier.sqlite'));
  t.after(async () => { for (const socket of sockets) socket.terminate(); await app.close(); db.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function request(path, { cookie = '', method = 'GET', body, origin = url } = {}) {
    const headers = { Cookie: cookie };
    if (origin !== null) headers.Origin = origin;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function guest(name) {
    const response = await request('/api/session', { method: 'POST', body: { name } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const cookie = response.headers.getSetCookie()[0].split(';')[0];
    return { cookie, user: response.data.user, request: (path, options = {}) => request(path, { ...options, cookie }) };
  }
  async function board(owner) {
    const response = await owner.request('/api/boards', { method: 'POST', body: { board: { title: 'Projet capacité', description: '', objects: [] } } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  }
  async function joinGuest(owner, other, id, role = 'editor') {
    const invite = await owner.request(`/api/boards/${id}/invitations`, { method: 'POST', body: { role } });
    assert.equal(invite.status, 201);
    const response = await other.request('/api/invitations/join', { method: 'POST', body: { token: invite.data.token } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return invite.data;
  }
  function live(guest, id) {
    const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/api/boards/${id}/live`, { headers: { Cookie: guest?.cookie || '', Origin: url } });
    sockets.add(socket);
    const inbox = [], waiters = new Set();
    const closed = new Promise(resolve => socket.once('close', (code, reason) => { sockets.delete(socket); resolve({ code, reason: reason.toString() }); }));
    socket.on('error', () => {});
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      for (const waiter of waiters) if (waiter.predicate(message)) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(message); return; }
      inbox.push(message);
    });
    function wait(predicate) {
      const index = inbox.findIndex(predicate);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Missing socket message: ${JSON.stringify(inbox)}`)); }, 5000);
        waiters.add(waiter);
      });
    }
    return { socket, inbox, wait, closed, send: message => socket.send(JSON.stringify(message)), close: async () => { socket.close(); await closed; } };
  }
  return { app, url, request, guest, board, joinGuest, live, db };
}

async function synchronized(environment, guest, id) {
  const client = environment.live(guest, id);
  client.initial = await client.wait(value => value.type === 'sync');
  return client;
}

async function busy(client) {
  const message = await client.wait(value => value.type === 'error');
  assert.equal(message.code, 'SERVER_BUSY');
  assert.equal(message.retryable, true);
  assert.equal(message.retryAfter, 2);
  assert.equal((await client.closed).code, 1013);
  assert.ok(client.inbox.every(value => !['sync', 'presence', 'update', 'ack'].includes(value.type)), 'A refused socket received project data');
}

test('Capacity defaults are configurable positive integers and invalid values fail before startup', async () => {
  assert.deepEqual(normalizeCapacity(), DEFAULT_CAPACITY);
  assert.equal(normalizeCapacity({ maxConnections: 7, maxIdleBoards: undefined }).maxConnections, 7);
  for (const name of Object.keys(DEFAULT_CAPACITY)) for (const value of [0, -1, 1.5, Infinity, '3', null]) {
    assert.throws(() => normalizeCapacity({ [name]: value }), new RegExp(name));
  }
  for (const value of [null, [], 'invalid']) assert.throws(() => normalizeCapacity(value));
});

test('Total capacity rejects authenticated members without state, ACK, membership or durable revision changes', async t => {
  const env = await fixture(t, { maxConnections: 2 });
  const owner = await env.guest('Propriétaire'), other = await env.guest('Éditeur'), extra = await env.guest('Lecteur');
  const created = await env.board(owner), id = created.board.id;
  await env.joinGuest(owner, other, id); await env.joinGuest(owner, extra, id, 'viewer');
  const first = await synchronized(env, owner, id), second = await synchronized(env, other, id);
  const before = env.db.prepare('SELECT state,revision FROM boards WHERE id=?').get(id);
  const memberCount = env.db.prepare('SELECT count(*) AS count FROM members').get().count;
  await busy(env.live(extra, id));
  const after = env.db.prepare('SELECT state,revision FROM boards WHERE id=?').get(id);
  assert.deepEqual(after, before);
  assert.equal(env.db.prepare('SELECT count(*) AS count FROM members').get().count, memberCount);
  assert.equal((await extra.request(`/api/boards/${id}`)).status, 200, 'Read-only exports remain accessible under capacity pressure');
  await second.close();
  const resumed = await synchronized(env, extra, id);
  assert.equal(resumed.initial.role, 'viewer');
  await first.close(); await resumed.close();
});

test('Participant connection limit applies across projects and releases after actual transport closure', async t => {
  const env = await fixture(t, { maxConnectionsPerUser: 1 });
  const owner = await env.guest('Multi-onglets');
  const a = await env.board(owner), b = await env.board(owner);
  const first = await synchronized(env, owner, a.board.id);
  await busy(env.live(owner, b.board.id));
  await busy(env.live(owner, a.board.id));
  await first.close();
  const resumed = await synchronized(env, owner, b.board.id);
  assert.equal(resumed.initial.role, 'owner');
});

test('Project participant and active-project limits preserve existing rooms and permit another join in an active room', async t => {
  const env = await fixture(t, { maxConnectionsPerBoard: 2, maxActiveBoards: 1 });
  const owner = await env.guest('Owner'), editor = await env.guest('Editor'), extra = await env.guest('Extra');
  const a = await env.board(owner), b = await env.board(owner);
  await env.joinGuest(owner, editor, a.board.id); await env.joinGuest(owner, extra, a.board.id);
  const first = await synchronized(env, owner, a.board.id);
  await busy(env.live(owner, b.board.id));
  const second = await synchronized(env, editor, a.board.id);
  await busy(env.live(extra, a.board.id));
  await first.close(); await second.close();
  await synchronized(env, owner, b.board.id);
});

test('Saturation does not convert missing sessions or missing memberships into temporary capacity grants', async t => {
  const env = await fixture(t, { maxConnections: 1 });
  const owner = await env.guest('Owner'), outsider = await env.guest('Outsider');
  const created = await env.board(owner), id = created.board.id;
  await synchronized(env, owner, id);
  for (const [guest, code] of [[null, 'SESSION_REQUIRED'], [outsider, 'FORBIDDEN']]) {
    const refused = env.live(guest, id);
    assert.equal((await refused.wait(value => value.type === 'error')).code, code);
    assert.equal((await refused.closed).code, 1008);
    assert.ok(refused.inbox.every(value => value.type === 'error'));
  }
});

test('Closing transports continue to consume total capacity until their close handshake completes', async t => {
  const env = await fixture(t, { maxConnections: 1 });
  const owner = await env.guest('Owner'), other = await env.guest('Other');
  const created = await env.board(owner), id = created.board.id;
  await env.joinGuest(owner, other, id);
  const first = await synchronized(env, owner, id);
  first.socket._socket.pause();
  assert.equal((await owner.request('/api/session', { method: 'DELETE' })).status, 200);
  await busy(env.live(other, id));
  first.socket._socket.resume();
  assert.equal((await first.closed).code, 1008);
  await synchronized(env, other, id);
});

test('An overload burst cannot accumulate unbounded WebSocket rejection transports awaiting close handshakes', async t => {
  const env = await fixture(t, { maxConnections: 1 });
  const owner = await env.guest('Owner'), created = await env.board(owner), id = created.board.id;
  await synchronized(env, owner, id);
  const rawSockets = [];
  async function stalledUpgrade() {
    const address = new URL(env.url);
    const socket = net.connect({ host: address.hostname, port: Number(address.port) });
    rawSockets.push(socket);
    return new Promise((resolve, reject) => {
      let response = '';
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Missing overload response')); }, 3000);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.on('data', bytes => {
        response += bytes.toString();
        const status = /^HTTP\/1\.1 (\d+)/.exec(response);
        if (status) { clearTimeout(timer); resolve(Number(status[1])); }
        // Deliberately never respond to WebSocket close frames: the transport
        // must remain accounted for until the server's bounded cleanup timer.
      });
      socket.once('connect', () => socket.write([
        `GET /api/boards/${id}/live HTTP/1.1`, `Host: ${address.host}`, `Origin: ${env.url}`,
        `Cookie: ${owner.cookie}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${Buffer.from(randomUUID().slice(0, 16)).toString('base64')}`, '', '',
      ].join('\r\n')));
    });
  }
  try {
    for (let index = 0; index < 16; ++index) assert.equal(await stalledUpgrade(), 101);
    assert.equal(await stalledUpgrade(), 503, 'Additional closing rejection transports must be refused before upgrade');
    assert.equal(env.db.prepare('SELECT revision FROM boards WHERE id=?').get(id).revision, 0);
  } finally { for (const socket of rawSockets) socket.destroy(); }
});

test('Idle HTTP previews remain bounded while every active-project slot is occupied', async t => {
  const env = await fixture(t, { maxActiveBoards: 1, maxIdleBoards: 1 });
  const owner = await env.guest('Owner');
  const active = await env.board(owner);
  const live = await synchronized(env, owner, active.board.id);
  const previews = await Promise.all([env.board(owner), env.board(owner), env.board(owner)]);
  await owner.request(`/api/boards/${previews.at(-1).board.id}`);
  const original = Y.Doc.prototype.destroy;
  let destroyed = 0;
  try {
    Y.Doc.prototype.destroy = function () { ++destroyed; return original.call(this); };
    for (const preview of previews) assert.equal((await owner.request(`/api/boards/${preview.board.id}`)).status, 200);
    assert.equal(destroyed, 3, 'Each distinct HTTP preview must evict an idle document, even with all active slots full');
    assert.equal((await owner.request(`/api/boards/${previews.at(-1).board.id}`)).status, 200);
    assert.equal(destroyed, 3, 'The most recent idle document remains cached');
    const doc = new Y.Doc(); Y.applyUpdate(doc, decodeBase64(live.initial.state));
    const vector = Y.encodeStateVector(doc); doc.getMap('meta').set('description', 'Room survives cache eviction');
    const id = randomUUID(); live.send({ type: 'update', id, update: encodeBase64(Y.encodeStateAsUpdate(doc, vector)) });
    assert.equal((await live.wait(value => value.id === id)).type, 'ack');
    doc.destroy();
    assert.equal((await owner.request(`/api/boards/${active.board.id}`)).data.board.description, 'Room survives cache eviction');
  } finally { Y.Doc.prototype.destroy = original; }
});

test('Presence cursor bursts are coalesced while document ACKs and permission changes remain immediate', async t => {
  const env = await fixture(t);
  const owner = await env.guest('Owner'), editor = await env.guest('Editor');
  const created = await env.board(owner), id = created.board.id;
  await env.joinGuest(owner, editor, id);
  const a = await synchronized(env, owner, id), b = await synchronized(env, editor, id);
  await a.wait(value => value.type === 'presence' && value.users.length === 2);
  a.inbox.length = 0;
  for (let index = 0; index < 20; ++index) b.send({ type: 'presence', cursor: { x: index, y: -index } });
  const presence = await a.wait(value => value.type === 'presence' && value.users.some(user => user.userId === editor.user.id && user.cursor?.x === 19));
  assert.equal(presence.users.length, 2);
  assert.equal(a.inbox.filter(value => value.type === 'presence').length, 0, 'One burst must produce one coalesced snapshot');
  b.send({ type: 'presence', cursor: { x: 25, y: 25 } });
  await owner.request(`/api/boards/${id}/members/${editor.user.id}`, { method: 'DELETE' });
  assert.equal((await b.closed).code, 1008);
  const departed = await a.wait(value => value.type === 'presence' && value.users.length === 1);
  assert.equal(departed.users[0].userId, owner.user.id);
  const serverClosed = env.app.close();
  assert.equal((await a.closed).code, 1006);
  await serverClosed;
});

test('Same-address guest creation and invitation bursts exceed the former 30/60 limits, with configurable protection retained', async t => {
  const env = await fixture(t, { maxConnectionsPerBoard: 80 });
  const owner = await env.guest('Owner'), created = await env.board(owner), id = created.board.id;
  const invite = await owner.request(`/api/boards/${id}/invitations`, { method: 'POST', body: { role: 'viewer' } });
  const guests = [];
  for (let index = 0; index < 65; ++index) {
    const guest = await env.guest(`Guest ${index}`);
    assert.equal((await guest.request('/api/invitations/join', { method: 'POST', body: { token: invite.data.token } })).status, 200);
    guests.push(guest);
  }
  const clients = await Promise.all(guests.map(guest => synchronized(env, guest, id)));
  assert.equal(clients.length, 65);
  assert.ok(clients.every(client => client.initial.role === 'viewer'));
});

test('Configured session and WebSocket rate limits stay bounded without blocking an existing guest session', async t => {
  const env = await fixture(t, { sessionCreationsPerMinute: 1, websocketConnectionsPerMinute: 1 });
  const owner = await env.guest('Owner'), created = await env.board(owner), id = created.board.id;
  assert.equal((await env.request('/api/session', { method: 'POST', body: { name: 'Overflow' } })).status, 429);
  assert.equal((await owner.request('/api/session', { method: 'POST', body: { name: 'Same owner' } })).status, 200);
  const first = await synchronized(env, owner, id);
  await first.close();
  await busy(env.live(owner, id));
  assert.equal((await owner.request('/api/session')).data.user.id, owner.user.id);
});
