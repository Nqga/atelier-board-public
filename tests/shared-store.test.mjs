import test from 'node:test';
import assert from 'node:assert/strict';
import { Y, docFromBoard, boardFromDoc, replaceYText, encodeBase64, decodeBase64 } from '../dist/shared-model.js';
import { CollaborativeBoardStore } from '../dist/collab-store.js';
import { createBoard } from '../dist/store.js';

const baseBoard = () => createBoard({ id: 'shared-board', title: 'Équipe', objects: [{ id: 'note-1', type: 'note', text: 'Bonjour monde', x: 10, y: 20, color: '#ffffff', votes: {} }] });
const metadata = doc => ({ board: boardFromDoc(doc, 'shared-board'), state: encodeBase64(Y.encodeStateAsUpdate(doc)), role: 'owner', revision: 1, updatedAt: '2026-10-12T12:00:00.000Z' });
const cloneDoc = doc => { const copy = new Y.Doc(); Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc)); return copy; };
const text = doc => doc.getMap('objects').get('note-1').get('text');
const object = store => store.board.objects.find(item => item.id === 'note-1');
class MemoryCache {
  constructor() { this.values = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) || null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); return true; }
  async list(prefix) { return [...this.values.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })); }
  async delete(key) { this.values.delete(key); return true; }
  async deleteIfUnchanged(key, expected) {
    const current = this.values.get(key);
    if (!current || current.state !== expected.state || current.hasPending !== expected.hasPending || current.rejected !== expected.rejected) return false;
    this.values.delete(key); return true;
  }
}
class MockSocket {
  static sockets = [];
  constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); this.sent = []; MockSocket.sockets.push(this); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  emit(type, value) { for (const fn of this.listeners.get(type) || []) fn(value); }
  open() { this.readyState = 1; this.emit('open', {}); }
  receive(message) { this.emit('message', { data: JSON.stringify(message) }); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', { code, reason }); }
}
const openStore = async (doc, options = {}) => CollaborativeBoardStore.open(metadata(doc), { user: { id: 'alice', name: 'Alice' }, url: 'ws://localhost/api/boards/shared-board/live', WebSocket: MockSocket, cache: false, batchDelay: 1000, ...options });
const sync = (socket, doc, role = 'owner') => { socket.open(); socket.receive({ type: 'sync', state: encodeBase64(Y.encodeStateAsUpdate(doc)), vector: encodeBase64(Y.encodeStateVector(doc)), role, revision: 1, updatedAt: '2026-10-12T12:00:00.000Z', users: [] }); };
const ackLast = socket => { const update = socket.sent.filter(message => message.type === 'update').at(-1); socket.receive({ type: 'ack', id: update.id, revision: 2, updatedAt: '2026-10-12T12:00:01.000Z' }); return update; };

test('concurrent text, object fields and individual votes converge without dropping independent edits', () => {
  const initial = docFromBoard(baseBoard()), alice = cloneDoc(initial), bob = cloneDoc(initial);
  alice.transact(() => { replaceYText(text(alice), 'Salut monde'); const note = alice.getMap('objects').get('note-1'); note.set('x', 200); note.get('votes').set('alice', 1); });
  bob.transact(() => { replaceYText(text(bob), 'Bonjour équipe'); const note = bob.getMap('objects').get('note-1'); note.set('color', '#00ff00'); note.get('votes').set('bob', 1); });
  const aliceUpdate = Y.encodeStateAsUpdate(alice), bobUpdate = Y.encodeStateAsUpdate(bob);
  Y.applyUpdate(alice, bobUpdate); Y.applyUpdate(bob, aliceUpdate);
  const result = boardFromDoc(alice, 'shared-board', { updatedAt: '2026-10-12' });
  assert.deepEqual(result, boardFromDoc(bob, 'shared-board', { updatedAt: '2026-10-12' }));
  assert.equal(result.objects[0].text, 'Salut équipe');
  assert.equal(result.objects[0].x, 200); assert.equal(result.objects[0].color, '#00ff00');
  assert.deepEqual(result.objects[0].votes, { alice: 1, bob: 1 });
  [initial, alice, bob].forEach(doc => doc.destroy());
});

test('shared validation rejects unknown roots and hidden nested shared types', () => {
  const initial = docFromBoard(baseBoard());
  const unknown = cloneDoc(initial); unknown.getMap('unauthorized').set('payload', 'surprise');
  assert.throws(() => boardFromDoc(unknown, 'shared-board'), /Racine/);
  const nested = cloneDoc(initial); nested.getMap('objects').get('note-1').set('custom', new Y.Array());
  assert.throws(() => boardFromDoc(nested, 'shared-board'), /Propriété/);
  const badVotes = cloneDoc(initial); badVotes.getMap('objects').get('note-1').get('votes').set('alice', 2);
  assert.throws(() => boardFromDoc(badVotes, 'shared-board'), /Vote/);
  const richText = cloneDoc(initial); text(richText).format(0, 1, { bold: true });
  assert.throws(() => boardFromDoc(richText, 'shared-board'), /Texte partagé/);
  const xmlText = cloneDoc(initial); xmlText.getMap('objects').get('note-1').set('text', new Y.XmlText('hidden XML'));
  assert.throws(() => boardFromDoc(xmlText, 'shared-board'), /Texte partagé/);
  [initial, unknown, nested, badVotes, richText, xmlText].forEach(doc => doc.destroy());
});

test('local undo preserves remote edits and remote changes do not enter the local undo stack', async t => {
  const initial = docFromBoard(baseBoard()), store = await openStore(initial), peer = cloneDoc(initial);
  t.after(() => { store.destroy(); initial.destroy(); peer.destroy(); });
  store.updateObject('note-1', { x: 90 });
  peer.getMap('objects').get('note-1').set('color', '#123456');
  store._applyRemote(Y.encodeStateAsUpdate(peer));
  assert.equal(store.canUndo, true);
  store.undo();
  assert.equal(object(store).x, 10); assert.equal(object(store).color, '#123456'); assert.equal(store.canUndo, false);
  store.redo(); assert.equal(object(store).x, 90); assert.equal(object(store).color, '#123456');
});

test('local text undo preserves another participant’s concurrent insertion', async t => {
  const initial = docFromBoard(baseBoard()), store = await openStore(initial), peer = cloneDoc(initial);
  t.after(() => { store.destroy(); initial.destroy(); peer.destroy(); });
  store.replaceText('note-1', 'Salut monde'); store.endTextEdit();
  replaceYText(text(peer), 'Bonjour équipe');
  store._applyRemote(Y.encodeStateAsUpdate(peer));
  assert.equal(object(store).text, 'Salut équipe');
  store.undo(); assert.equal(object(store).text, 'Bonjour équipe');
});

test('concurrent deletion and edits converge to deletion without resurrection', () => {
  const initial = docFromBoard(baseBoard()), removed = cloneDoc(initial), edited = cloneDoc(initial);
  removed.getMap('objects').delete('note-1'); replaceYText(text(edited), 'Texte modifié');
  const removeUpdate = Y.encodeStateAsUpdate(removed), editUpdate = Y.encodeStateAsUpdate(edited);
  Y.applyUpdate(removed, editUpdate); Y.applyUpdate(edited, removeUpdate);
  assert.equal(boardFromDoc(removed, 'shared-board').objects.length, 0); assert.equal(boardFromDoc(edited, 'shared-board').objects.length, 0);
  [initial, removed, edited].forEach(doc => doc.destroy());
});

test('sync and browser cache never claim durable saving before the corresponding server ACK', async t => {
  const initial = docFromBoard(baseBoard()), cache = new MemoryCache(), store = await openStore(initial, { cache });
  t.after(() => { store.destroy(); initial.destroy(); });
  const socket = store.socket;
  sync(socket, initial);
  assert.equal(store.status, 'syncing'); assert.equal(store.lastSaved, false);
  ackLast(socket); assert.equal(store.status, 'synced'); assert.equal(store.lastSaved, true);
  store.updateObject('note-1', { x: 88 }); await store.save();
  assert.equal(store.hasPending, true); assert.equal(store.cacheSaved, true); assert.equal(store.lastSaved, false);
  socket.receive({ type: 'ack', id: 'unrelated', revision: 100 }); assert.equal(store.lastSaved, false);
  ackLast(socket); await store._cacheChain;
  assert.equal(store.lastSaved, true); assert.equal(store.hasPending, false);
  assert.equal((await cache.get(store.cacheKey)).hasPending, false);
});

test('pending edits survive reload and restore before the first websocket connection', async t => {
  const initial = docFromBoard(baseBoard()), cache = new MemoryCache(), first = await openStore(initial, { cache });
  first.replaceText('note-1', 'Mon brouillon hors ligne'); await first.save(); first.destroy(); await first._cacheChain;
  let restoredAtConnection = false;
  class RestoreSocket extends MockSocket { constructor(url) { super(url); restoredAtConnection = cache.values.get('alice:shared-board').hasPending; } }
  const reopened = await openStore(initial, { cache, WebSocket: RestoreSocket });
  t.after(() => { reopened.destroy(); initial.destroy(); });
  assert.equal(restoredAtConnection, true); assert.equal(object(reopened).text, 'Mon brouillon hors ligne'); assert.equal(reopened.hasPending, true);
  sync(reopened.socket, initial);
  const missing = reopened.socket.sent.find(message => message.type === 'update');
  Y.applyUpdate(initial, decodeBase64(missing.update));
  assert.equal(boardFromDoc(initial, 'shared-board').objects[0].text, 'Mon brouillon hors ligne');
  ackLast(reopened.socket); assert.equal(reopened.lastSaved, true);
});

test('a viewer ignores an unaccepted cached draft while retaining its recovery copy', async t => {
  const initial = docFromBoard(baseBoard()), cache = new MemoryCache(), first = await openStore(initial, { cache });
  first.replaceText('note-1', 'Copie non envoyée'); await first.save(); first.destroy(); await first._cacheChain;
  const viewer = await CollaborativeBoardStore.open({ ...metadata(initial), role: 'viewer' }, { user: { id: 'alice' }, cache, url: 'ws://localhost/live', WebSocket: MockSocket });
  t.after(() => { viewer.destroy(); initial.destroy(); });
  assert.equal(object(viewer).text, 'Bonjour monde'); assert.equal(viewer.canEdit, false); assert.ok(viewer.recoveryDraft?.hasPending);
  assert.throws(() => viewer.replaceText('note-1', 'Interdit'), /lecture seule/);
  sync(viewer.socket, initial, 'viewer'); assert.equal(viewer.status, 'readonly'); assert.equal(viewer.socket.sent.some(message => message.type === 'update'), false);
  await viewer._cacheChain; assert.equal((await cache.get(viewer.cacheKey)).hasPending, false); assert.equal((await cache.get(viewer.recoveryKey)).hasPending, true);
});

test('a rejected update retains a recoverable draft and never silently reports synced', async t => {
  const initial = docFromBoard(baseBoard()), cache = new MemoryCache(), store = await openStore(initial, { cache });
  t.after(() => { store.destroy(); initial.destroy(); });
  sync(store.socket, initial); ackLast(store.socket);
  store.replaceText('note-1', 'Modification refusée'); await store.save();
  const sent = store.socket.sent.filter(message => message.type === 'update').at(-1);
  store.socket.receive({ type: 'error', id: sent.id, code: 'INVALID_UPDATE', message: 'Refus du serveur' });
  await store._cacheChain;
  assert.equal(store.status, 'error'); assert.equal(store.lastSaved, false); assert.equal(store.hasPending, true); assert.equal(store.canEdit, false);
  assert.equal(store.recoveryDraft.board.objects[0].text, 'Modification refusée');
  assert.equal((await cache.get(store.cacheKey)).rejected, true);
});

test('a pending local vote cannot overwrite another participant’s vote', async t => {
  const initial = docFromBoard(baseBoard()), store = await openStore(initial), peer = cloneDoc(initial);
  t.after(() => { store.destroy(); initial.destroy(); peer.destroy(); });
  peer.getMap('objects').get('note-1').get('votes').set('bob', 1); store._applyRemote(Y.encodeStateAsUpdate(peer));
  store.updateObject('note-1', { votes: { alice: 1 } });
  assert.deepEqual(object(store).votes, { bob: 1, alice: 1 });
  assert.throws(() => store.updateObject('note-1', { votes: { bob: 0, alice: 1 } }), /propre vote/);
});

test('missing acknowledgements trigger reconnect and replay only the missing CRDT state', async t => {
  const initial = docFromBoard(baseBoard()), cache = new MemoryCache();
  const store = await openStore(initial, { cache, ackTimeout: 25, reconnectMin: 2, reconnectMax: 2 });
  t.after(() => { store.destroy(); initial.destroy(); });
  const firstSocket = store.socket; sync(firstSocket, initial); ackLast(firstSocket);
  store.updateObject('note-1', { x: 777 }); await store.save();
  // The server committed this update, but its ACK got lost on the network.
  const sent = firstSocket.sent.filter(message => message.type === 'update').at(-1);
  Y.applyUpdate(initial, decodeBase64(sent.update));
  const reconnectDeadline = Date.now() + 1000;
  while ((!store.socket || store.socket === firstSocket) && Date.now() < reconnectDeadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(firstSocket.readyState, 3); assert.ok(store.socket); assert.notEqual(store.socket, firstSocket);
  assert.equal(store.lastSaved, false); assert.equal(store.hasPending, true);
  sync(store.socket, initial); ackLast(store.socket);
  assert.equal(object(store).x, 777); assert.equal(store.lastSaved, true); assert.equal(store.hasPending, false);
});

test('an old ACK cannot clear later local edits or a second in-flight update', async t => {
  const initial = docFromBoard(baseBoard()), store = await openStore(initial);
  t.after(() => { store.destroy(); initial.destroy(); });
  const socket = store.socket; sync(socket, initial); ackLast(socket);
  store.updateObject('note-1', { x: 50 }); await store.save();
  const first = socket.sent.filter(message => message.type === 'update').at(-1);
  store.updateObject('note-1', { y: 75 }); await store.save();
  const second = socket.sent.filter(message => message.type === 'update').at(-1);
  socket.receive({ type: 'ack', id: first.id, revision: 3, updatedAt: '2026-10-12T12:00:02.000Z' });
  assert.equal(store.lastSaved, false); assert.equal(store.hasPending, true);
  socket.receive({ type: 'ack', id: second.id, revision: 4, updatedAt: '2026-10-12T12:00:03.000Z' });
  assert.equal(store.lastSaved, true); assert.equal(store.hasPending, false);
});

test('minimal text replacements preserve emoji surrogate pairs', () => {
  const initial = docFromBoard(baseBoard());
  replaceYText(text(initial), 'Bonjour 🙂 monde');
  replaceYText(text(initial), 'Bonjour 🙃 monde');
  assert.equal(text(initial).toString(), 'Bonjour 🙃 monde');
  replaceYText(text(initial), '👍🏽');
  replaceYText(text(initial), '👍🏻');
  assert.equal(text(initial).toString(), '👍🏻');
  initial.destroy();
});

test('empty boards validate after their roots are serialized through Yjs', async t => {
  const initial = docFromBoard(createBoard({ id: 'shared-board', objects: [] })), restored = cloneDoc(initial);
  assert.equal(boardFromDoc(restored, 'shared-board').objects.length, 0);
  const store = await openStore(initial);
  t.after(() => { store.destroy(); initial.destroy(); restored.destroy(); });
  store.addObject({ id: 'first-note', type: 'note', text: 'Première idée' });
  assert.equal(store.board.objects.length, 1);
});

test('promoting a connected viewer to editor confirms durability before reporting synced', async t => {
  const initial = docFromBoard(baseBoard());
  const store = await CollaborativeBoardStore.open({ ...metadata(initial), role: 'viewer' }, { user: { id: 'alice' }, cache: false, url: 'ws://localhost/live', WebSocket: MockSocket });
  t.after(() => { store.destroy(); initial.destroy(); });
  sync(store.socket, initial, 'viewer'); assert.equal(store.status, 'readonly');
  store.socket.receive({ type: 'role', role: 'editor' });
  assert.equal(store.canEdit, true); assert.equal(store.status, 'syncing'); assert.equal(store.lastSaved, false);
  ackLast(store.socket); assert.equal(store.status, 'synced'); assert.equal(store.lastSaved, true);
});

test('browser stores synchronize through the real durable websocket server and live role changes', async t => {
  const [{ createAtelierServer }, { default: NodeWebSocket }, { mkdtemp, rm }, { tmpdir }, { join }] = await Promise.all([
    import('../server.mjs'), import('ws'), import('node:fs/promises'), import('node:os'), import('node:path'),
  ]);
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-store-live-'));
  const server = await createAtelierServer({ port: 0, host: '127.0.0.1', dataDir });
  const { url } = await server.start();
  const stores = [];
  t.after(async () => { for (const store of stores) store.destroy(); await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function guest(name) {
    let cookie = '';
    async function request(path, method = 'GET', body) {
      const response = await fetch(url + path, { method, headers: { Origin: url, Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const setCookie = response.headers.getSetCookie()[0]; if (setCookie) cookie = setCookie.split(';')[0];
      const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
    }
    const { user } = await request('/api/session', 'POST', { name });
    class GuestSocket extends NodeWebSocket { constructor(socketUrl) { super(socketUrl, { headers: { Origin: url, Cookie: cookie } }); } }
    return { user, request, WebSocket: GuestSocket };
  }
  const alice = await guest('Alice'), bob = await guest('Bob');
  const initial = await alice.request('/api/boards', 'POST', { board: baseBoard() });
  const boardId = initial.board.id;
  const invitation = await alice.request(`/api/boards/${boardId}/invitations`, 'POST', { role: 'editor', expiresInDays: 1 });
  const bobMeta = await bob.request('/api/invitations/join', 'POST', { token: invitation.token });
  const liveUrl = url.replace(/^http/, 'ws') + `/api/boards/${boardId}/live`;
  const a = await CollaborativeBoardStore.open(initial, { user: alice.user, WebSocket: alice.WebSocket, cache: false, url: liveUrl, batchDelay: 2 });
  const b = await CollaborativeBoardStore.open(bobMeta, { user: bob.user, WebSocket: bob.WebSocket, cache: false, url: liveUrl, batchDelay: 2 });
  stores.push(a, b);
  const waitFor = async (store, predicate, label) => {
    if (predicate()) return;
    await new Promise((resolve, reject) => {
      const cleanups = []; const finish = () => { clearTimeout(timer); for (const cleanup of cleanups) cleanup(); resolve(); };
      const timer = setTimeout(() => { for (const cleanup of cleanups) cleanup(); reject(new Error(`${label}: ${JSON.stringify(store._statusInfo())}`)); }, 5000);
      const check = () => { if (predicate()) finish(); };
      cleanups.push(store.subscribe(check), store.onStatus(check));
    });
  };
  await Promise.all([waitFor(a, () => a.status === 'synced', 'Alice initial sync'), waitFor(b, () => b.status === 'synced', 'Bob initial sync')]);
  a.batch('Alice concurrent changes', () => { a.replaceText('note-1', 'Salut monde'); a.updateObject('note-1', { x: 100, votes: { [alice.user.id]: 1 } }); });
  b.batch('Bob concurrent changes', () => { b.replaceText('note-1', 'Bonjour équipe'); b.updateObject('note-1', { y: 150, votes: { [bob.user.id]: 1 } }); });
  await Promise.all([
    waitFor(a, () => a.lastSaved && object(a).text === 'Salut équipe' && object(a).y === 150 && Object.keys(object(a).votes).length === 2, 'Alice concurrent convergence'),
    waitFor(b, () => b.lastSaved && object(b).text === 'Salut équipe' && object(b).x === 100 && Object.keys(object(b).votes).length === 2, 'Bob concurrent convergence'),
  ]);
  assert.deepEqual(a.board.objects, b.board.objects);
  assert.equal((await alice.request(`/api/boards/${boardId}`)).board.objects[0].text, 'Salut équipe');
  a.undo();
  await waitFor(b, () => object(b).text === 'Bonjour équipe' && object(b).x === 10, 'Remote sees local-only undo');
  assert.equal(object(b).y, 150); assert.equal(object(b).votes[bob.user.id], 1);
  await alice.request(`/api/boards/${boardId}/members/${bob.user.id}`, 'PATCH', { role: 'viewer' });
  await waitFor(b, () => b.role === 'viewer' && b.status === 'readonly', 'Live read-only demotion');
  assert.equal(b.canEdit, false);
  await alice.request(`/api/boards/${boardId}/members/${bob.user.id}`, 'PATCH', { role: 'editor' });
  await waitFor(b, () => b.role === 'editor' && b.status === 'synced' && b.lastSaved, 'Live editor promotion ACK');
  b.replaceText('note-1', 'Équipe reconnectée');
  await waitFor(a, () => object(a).text === 'Équipe reconnectée', 'Re-promoted editor writes');
});

test('IME composition buffers remote text until its local input is committed, then merges both edits', async t => {
  const initial = docFromBoard(baseBoard()), store = await openStore(initial), peer = cloneDoc(initial);
  t.after(() => { store.destroy(); initial.destroy(); peer.destroy(); });
  store.pauseRemote();
  replaceYText(text(peer), 'Bonjour équipe');
  store._receive({ type: 'update', update: encodeBase64(Y.encodeStateAsUpdate(peer)), revision: 2 });
  assert.equal(object(store).text, 'Bonjour monde');
  store.replaceText('note-1', 'こんにちは monde');
  assert.equal(object(store).text, 'こんにちは monde');
  store.resumeRemote();
  assert.equal(object(store).text, 'こんにちは équipe');
});

test('IME buffering keeps ACKs, role changes and revocation immediate', async t => {
  const initial = docFromBoard(baseBoard()), store = await openStore(initial), peer = cloneDoc(initial);
  t.after(() => { store.destroy(); initial.destroy(); peer.destroy(); });
  sync(store.socket, initial); ackLast(store.socket);
  store.pauseRemote(); store.replaceText('note-1', 'こんにちは monde'); await store.save();
  replaceYText(text(peer), 'Bonjour équipe');
  store.socket.receive({ type: 'update', update: encodeBase64(Y.encodeStateAsUpdate(peer)), revision: 3 });
  ackLast(store.socket);
  assert.equal(store.lastSaved, true); assert.equal(store.status, 'syncing'); assert.equal(store.hasPending, false);
  store.socket.receive({ type: 'role', role: 'viewer' });
  assert.equal(store.canEdit, false); assert.equal(store.status, 'readonly');
  store.socket.receive({ type: 'error', code: 'REVOKED', message: 'Accès retiré' });
  assert.equal(store.status, 'denied'); assert.equal(store.lastSaved, false);
  store.resumeRemote();
  assert.equal(store.status, 'denied'); assert.equal(store.canEdit, false);
});

test('a recovery draft survives viewer promotion and subsequent accepted cache writes', async t => {
  const initial = docFromBoard(baseBoard()), cache = new MemoryCache(), first = await openStore(initial, { cache });
  first.replaceText('note-1', 'Brouillon à récupérer'); await first.save(); first.destroy(); await first._cacheChain;
  const viewer = await CollaborativeBoardStore.open({ ...metadata(initial), role: 'viewer' }, { user: { id: 'alice' }, cache, url: 'ws://localhost/live', WebSocket: MockSocket });
  sync(viewer.socket, initial, 'viewer');
  viewer.socket.receive({ type: 'role', role: 'editor' }); ackLast(viewer.socket); await viewer._cacheChain;
  assert.equal((await cache.get(viewer.cacheKey)).hasPending, false);
  const recovery = await cache.get(viewer.recoveryKey); assert.equal(recovery.hasPending, true);
  const draftDoc = new Y.Doc(); Y.applyUpdate(draftDoc, decodeBase64(recovery.state));
  assert.equal(boardFromDoc(draftDoc, 'shared-board').objects[0].text, 'Brouillon à récupérer');
  viewer.destroy(); await viewer._cacheChain;
  const editor = await openStore(initial, { cache });
  t.after(() => { editor.destroy(); initial.destroy(); draftDoc.destroy(); });
  assert.equal(object(editor).text, 'Bonjour monde'); assert.ok(editor.recoveryDraft?.hasPending); assert.equal(editor.canEdit, true);
});

test('a reconnect sync during IME preserves the local composition and intervening remote text', async t => {
  const initial = docFromBoard(baseBoard()), store = await openStore(initial), peer = cloneDoc(initial);
  t.after(() => { store.destroy(); initial.destroy(); peer.destroy(); });
  sync(store.socket, initial); ackLast(store.socket);
  store.pauseRemote();
  replaceYText(text(peer), 'Bonjour équipe');
  store.socket.receive({ type: 'sync', state: encodeBase64(Y.encodeStateAsUpdate(peer)), vector: encodeBase64(Y.encodeStateVector(peer)), role: 'editor', revision: 2, users: [] });
  assert.equal(object(store).text, 'Bonjour monde');
  assert.equal(store.role, 'editor');
  store.replaceText('note-1', 'こんにちは monde');
  store.resumeRemote();
  assert.equal(object(store).text, 'こんにちは équipe');
  ackLast(store.socket); assert.equal(store.lastSaved, true);
});

test('a reconnect read-only role applies immediately while its text sync is paused by IME', async t => {
  const initial = docFromBoard(baseBoard()), store = await openStore(initial), peer = cloneDoc(initial);
  t.after(() => { store.destroy(); initial.destroy(); peer.destroy(); });
  sync(store.socket, initial); ackLast(store.socket); store.pauseRemote();
  replaceYText(text(peer), 'Bonjour équipe');
  store.socket.receive({ type: 'sync', state: encodeBase64(Y.encodeStateAsUpdate(peer)), vector: encodeBase64(Y.encodeStateVector(peer)), role: 'viewer', revision: 2, users: [] });
  assert.equal(store.role, 'viewer'); assert.equal(store.canEdit, false); assert.equal(store.status, 'readonly');
  assert.equal(object(store).text, 'Bonjour monde');
  store.resumeRemote(); assert.equal(object(store).text, 'Bonjour équipe'); assert.equal(store.canEdit, false);
});

test('temporary save failures and rate limits retain a retryable draft with increasing reconnect backoff', async t => {
  const initial = docFromBoard(baseBoard()), cache = new MemoryCache(), store = await openStore(initial, { cache, reconnectMin: 2, reconnectMax: 20 });
  t.after(() => { store.destroy(); initial.destroy(); });
  sync(store.socket, initial); ackLast(store.socket);
  store.replaceText('note-1', 'Brouillon conservé'); await store.save();
  for (const [index, code] of ['SAVE_FAILED', 'RATE_LIMIT'].entries()) {
    const oldSocket = store.socket;
    oldSocket.receive({ type: 'error', code, message: 'Indisponibilité temporaire' });
    await store._cacheChain;
    assert.equal(store.status, 'offline'); assert.equal(store.rejected, false); assert.equal(store.canEdit, true);
    assert.equal(store.lastSaved, false); assert.equal(store.hasPending, true); assert.equal(store.recoveryDraft, undefined);
    assert.equal((await cache.get(store.cacheKey)).rejected, false);
    assert.equal(store.reconnectAttempts, index + 1);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(store.socket && store.socket !== oldSocket);
    sync(store.socket, initial);
    assert.equal(store.reconnectAttempts, index + 1, 'a sync without durable ACK does not reset retry backoff');
    assert.equal(object(store).text, 'Brouillon conservé');
  }
  const missing = store.socket.sent.filter(message => message.type === 'update').at(-1);
  Y.applyUpdate(initial, decodeBase64(missing.update)); ackLast(store.socket); await store._cacheChain;
  assert.equal(boardFromDoc(initial, 'shared-board').objects[0].text, 'Brouillon conservé');
  assert.equal(store.status, 'synced'); assert.equal(store.lastSaved, true); assert.equal(store.hasPending, false);
  assert.equal(store.reconnectAttempts, 0); assert.equal((await cache.get(store.cacheKey)).hasPending, false);
});

test('authorization failures remain permanent and never auto-retry an unauthorized draft', async t => {
  const initial = docFromBoard(baseBoard()), cache = new MemoryCache(), store = await openStore(initial, { cache, reconnectMin: 2 });
  t.after(() => { store.destroy(); initial.destroy(); });
  sync(store.socket, initial); ackLast(store.socket);
  store.replaceText('note-1', 'Brouillon accès retiré'); await store.save();
  store.socket.receive({ type: 'error', code: 'FORBIDDEN', message: 'Accès retiré' }); await store._cacheChain;
  assert.equal(store.status, 'denied'); assert.equal(store.rejected, true); assert.equal(store.canEdit, false);
  assert.equal(store.hasPending, true); assert.equal(store.lastSaved, false);
  assert.equal((await cache.get(store.cacheKey)).rejected, true); assert.ok(store.recoveryDraft);
  assert.equal(store._reconnectTimer, undefined);
});

test('two offline tabs with the same guest retain and merge both drafts after their cache snapshots race', async t => {
  const initial = docFromBoard(baseBoard()), cache = new MemoryCache();
  const [a, b] = await Promise.all([openStore(initial, { cache }), openStore(initial, { cache })]);
  a.batch('Onglet A', () => { a.replaceText('note-1', 'Salut monde'); a.updateObject('note-1', { x: 700 }); });
  b.batch('Onglet B', () => { b.replaceText('note-1', 'Bonjour équipe'); b.updateObject('note-1', { y: 800 }); });
  await Promise.all([a.save(), b.save()]);
  assert.notEqual(a.pendingSlotKey, b.pendingSlotKey); assert.equal((await cache.list(a.pendingPrefix)).length, 2);
  a.destroy(); b.destroy(); await Promise.all([a._cacheChain, b._cacheChain]);
  const reopened = await openStore(initial, { cache });
  assert.equal(object(reopened).text, 'Salut équipe'); assert.equal(object(reopened).x, 700); assert.equal(object(reopened).y, 800); assert.equal(reopened.hasPending, true);
  sync(reopened.socket, initial);
  const missing = reopened.socket.sent.filter(message => message.type === 'update').at(-1);
  Y.applyUpdate(initial, decodeBase64(missing.update)); ackLast(reopened.socket); await reopened._cacheChain;
  reopened.destroy(); await reopened._cacheChain;
  const acknowledged = await openStore(initial, { cache });
  t.after(() => { acknowledged.destroy(); initial.destroy(); });
  assert.equal(object(acknowledged).text, 'Salut équipe'); assert.equal(object(acknowledged).x, 700); assert.equal(object(acknowledged).y, 800);
  assert.equal(acknowledged.hasPending, false, 'old pending snapshots are recognized as durably covered');
  assert.equal((await cache.list(acknowledged.pendingPrefix)).length, 0, 'only server-covered obsolete slots are removed');
});

test('an acknowledged tab cannot erase another same-guest tab’s unsent changes', async t => {
  const initial = docFromBoard(baseBoard()), cache = new MemoryCache(), a = await openStore(initial, { cache }), b = await openStore(initial, { cache });
  sync(a.socket, initial); ackLast(a.socket);
  b.updateObject('note-1', { y: 900 }); await b.save();
  a.updateObject('note-1', { x: 600 }); await a.save();
  const sent = a.socket.sent.filter(message => message.type === 'update').at(-1);
  Y.applyUpdate(initial, decodeBase64(sent.update)); ackLast(a.socket); await a._cacheChain;
  assert.equal((await cache.get(a.cacheKey)).hasPending, false, 'the last shared snapshot contains the acknowledged tab');
  assert.ok(await cache.get(b.pendingSlotKey), 'the other tab’s pending slot survives that ACK');
  a.destroy(); b.destroy(); await Promise.all([a._cacheChain, b._cacheChain]);
  const reopened = await openStore(initial, { cache });
  t.after(() => { reopened.destroy(); initial.destroy(); });
  assert.equal(object(reopened).x, 600); assert.equal(object(reopened).y, 900); assert.equal(reopened.hasPending, true);
});

test('cache coverage includes deletion tombstones even when server and draft state vectors match', async t => {
  const initial = docFromBoard(baseBoard()), cache = new MemoryCache(), first = await openStore(initial, { cache });
  first.removeObject('note-1');
  assert.deepEqual(Y.encodeStateVector(first.doc), Y.encodeStateVector(initial), 'Yjs deletions do not advance the client state vector');
  await first.save(); first.destroy(); await first._cacheChain;
  const reopened = await openStore(initial, { cache });
  assert.equal(reopened.board.objects.length, 0); assert.equal(reopened.hasPending, true);
  sync(reopened.socket, initial);
  const missing = reopened.socket.sent.filter(message => message.type === 'update').at(-1);
  Y.applyUpdate(initial, decodeBase64(missing.update)); ackLast(reopened.socket); await reopened._cacheChain;
  reopened.destroy(); await reopened._cacheChain;
  const acknowledged = await openStore(initial, { cache });
  t.after(() => { acknowledged.destroy(); initial.destroy(); });
  assert.equal(acknowledged.board.objects.length, 0); assert.equal(acknowledged.hasPending, false);
  assert.equal((await cache.list(acknowledged.pendingPrefix)).length, 0);
});

test('cleaning an acknowledged stale slot cannot delete a newer draft written by its still-active tab', async t => {
  class RacingCache extends MemoryCache {
    async deleteIfUnchanged(key, expected) {
      if (this.replacement && !this.raced) { this.raced = true; await this.set(key, this.replacement); }
      return super.deleteIfUnchanged(key, expected);
    }
  }
  const initial = docFromBoard(baseBoard()), cache = new RacingCache(), first = await openStore(initial, { cache });
  first.updateObject('note-1', { x: 333 }); await first.save();
  const originalSlot = await cache.get(first.pendingSlotKey), newer = cloneDoc(first.doc);
  newer.getMap('objects').get('note-1').set('y', 444);
  cache.replacement = { ...originalSlot, state: encodeBase64(Y.encodeStateAsUpdate(newer)), hasPending: true };
  Y.applyUpdate(initial, decodeBase64(originalSlot.state));
  first.destroy(); await first._cacheChain;
  const cleaning = await openStore(initial, { cache });
  assert.equal(cache.raced, true); assert.ok(await cache.get(first.pendingSlotKey), 'conditional cleanup preserves the changed slot');
  cleaning.destroy(); await cleaning._cacheChain;
  const restored = await openStore(initial, { cache });
  t.after(() => { restored.destroy(); initial.destroy(); newer.destroy(); });
  assert.equal(object(restored).x, 333); assert.equal(object(restored).y, 444); assert.equal(restored.hasPending, true);
});

test('cacheSaved remains false until the newest queued draft is actually written', async t => {
  class DelayedCache extends MemoryCache {
    constructor() { super(); this.waiters = []; this.blocked = false; }
    async set(key, value) {
      if (this.blocked && key === 'alice:shared-board') await new Promise(resolve => this.waiters.push(resolve));
      return super.set(key, value);
    }
  }
  const initial = docFromBoard(baseBoard()), cache = new DelayedCache(), store = await openStore(initial, { cache });
  t.after(() => { cache.blocked = false; for (const resolve of cache.waiters) resolve(); store.destroy(); initial.destroy(); });
  const waiting = async () => { while (!cache.waiters.length) await new Promise(resolve => setTimeout(resolve, 1)); };
  cache.blocked = true;
  store.updateObject('note-1', { x: 11 }); await waiting();
  store.updateObject('note-1', { y: 22 });
  cache.waiters.shift()(); await waiting();
  assert.equal(store.cacheSaved, false, 'the first completed write cannot confirm the second queued edit');
  cache.blocked = false; cache.waiters.shift()(); await store._cacheChain;
  assert.equal(store.cacheSaved, true);
});
