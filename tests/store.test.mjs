import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardStore, BroadcastBoardTransport, createBoard, validateBoard, LocalBoardRepository, DOCUMENT_LIMITS } from '../dist/store.js';

class MemoryStorage {
  constructor() { this.values = new Map(); this.failState = false; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.failState && key.includes(':state:')) throw new Error('Quota'); this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}
const document = () => createBoard({ id: 'test-board', title: 'Atelier', objects: [{ id: 'note-1', type: 'note', x: 20, y: 30, width: 200, height: 160, text: 'Une idée', color: '#fff4a8', votes: {} }] });
const store = (board = document(), options = {}) => new BoardStore(board, { storage: null, sync: false, ...options });
const only = instance => instance.board.objects.find(object => object.id === 'note-1');
function captured(instance) { const values = []; instance.onOperation((operation, event) => { if (event.source === 'local') values.push(operation); }); return values; }

test('snapshots, inputs and callbacks cannot mutate the internal document', () => {
  const board = document(); const instance = store(board);
  board.objects[0].text = 'Muté';
  const snapshot = instance.board; snapshot.objects[0].text = 'Muté encore';
  instance.subscribe(value => { value.objects[0].text = 'Callback'; });
  instance.updateObject('note-1', { x: 42 });
  assert.equal(only(instance).text, 'Une idée');
  assert.equal(only(instance).x, 42);
});

test('grouped edits undo and redo as one action with one render notification', () => {
  const instance = store(); let notifications = 0;
  instance.subscribe(() => notifications++);
  instance.batch('Déplacer et recolorer', () => {
    instance.updateObject('note-1', { x: 100 });
    instance.updateObject('note-1', { color: '#95d5ff', y: 200 });
  });
  assert.equal(notifications, 1);
  assert.equal(instance.canUndo, true);
  assert.equal(instance.undo(), true);
  assert.equal(only(instance).x, 20); assert.equal(only(instance).y, 30); assert.equal(only(instance).color, '#fff4a8');
  assert.equal(instance.canUndo, false); assert.equal(instance.canRedo, true);
  assert.equal(instance.redo(), true);
  assert.equal(only(instance).x, 100); assert.equal(only(instance).y, 200);
  instance.updateObject('note-1', { text: 'Suite' });
  assert.equal(instance.canRedo, false);
});

test('add, delete, field removal and title changes are undoable', () => {
  const instance = store();
  const id = instance.addObject({ type: 'text', text: 'Bonjour', x: -30, y: 0 });
  instance.removeObject(id); assert.equal(instance.board.objects.length, 1);
  instance.undo(); assert.equal(instance.board.objects.length, 2);
  instance.undo(); assert.equal(instance.board.objects.length, 1);
  instance.redo(); assert.equal(instance.board.objects.length, 2);
  instance.updateObject('note-1', { author: 'JD' });
  instance.updateObject('note-1', { author: undefined });
  assert.equal(Object.hasOwn(only(instance), 'author'), false);
  instance.undo(); assert.equal(only(instance).author, 'JD');
  instance.setTitle('Nouveau'); assert.equal(instance.board.title, 'Nouveau');
  instance.undo(); assert.equal(instance.board.title, 'Atelier');
});

test('concurrent edits to different fields converge without snapshot overwrites', () => {
  const initial = document(); const a = store(initial, { actorId: 'alice' }); const b = store(initial, { actorId: 'bob' });
  const aOps = captured(a); const bOps = captured(b);
  a.updateObject('note-1', { x: 120 }); b.updateObject('note-1', { text: 'Vote partagé' });
  a.receiveOperation(bOps[0]); b.receiveOperation(aOps[0]);
  assert.deepEqual(a.board.objects, b.board.objects);
  assert.equal(only(a).x, 120); assert.equal(only(a).text, 'Vote partagé');
  assert.equal(a.receiveOperation(bOps[0]), false);
  a.undo(); assert.equal(only(a).x, 20); assert.equal(only(a).text, 'Vote partagé');
});

test('same-field ties have deterministic actor order and stale operations cannot resurrect deletion', () => {
  const initial = document(); const a = store(initial, { actorId: 'alice' }); const b = store(initial, { actorId: 'bob' });
  const aOps = captured(a); const bOps = captured(b);
  a.updateObject('note-1', { text: 'A' }); b.updateObject('note-1', { text: 'B' });
  a.receiveOperation(bOps[0]); b.receiveOperation(aOps[0]);
  assert.equal(only(a).text, 'B'); assert.equal(only(b).text, 'B');
  a.removeObject('note-1'); b.receiveOperation(aOps[1]);
  b.receiveOperation(aOps[0]); assert.equal(b.board.objects.length, 0);
  a.undo(); b.receiveOperation(aOps[2]);
  assert.deepEqual(a.board.objects, b.board.objects);
});

test('updates arriving before creation are retained and merged when creation arrives', () => {
  const source = store(createBoard({ id: 'empty' })); const target = store(createBoard({ id: 'empty' })); const operations = captured(source);
  source.addObject({ id: 'new-note', type: 'note', text: 'Initial' });
  source.updateObject('new-note', { text: 'Révisé' });
  assert.equal(target.receiveOperation(operations[1]), true);
  assert.equal(target.board.objects.length, 0);
  target.receiveOperation(operations[0]);
  assert.equal(target.board.objects[0].text, 'Révisé');
});

test('concurrent votes merge per participant; undo only removes the local vote', () => {
  const initial = document(); const a = store(initial, { actorId: 'alice' }); const b = store(initial, { actorId: 'bob' });
  const aOps = captured(a); const bOps = captured(b);
  a.updateObject('note-1', { votes: { alice: 1 } }); b.updateObject('note-1', { votes: { bob: 1 } });
  a.receiveOperation(bOps[0]); b.receiveOperation(aOps[0]);
  assert.deepEqual(only(a).votes, { alice: 1, bob: 1 });
  assert.deepEqual(only(b).votes, { bob: 1, alice: 1 });
  a.undo(); b.receiveOperation(aOps[1]);
  assert.deepEqual(only(a).votes, { bob: 1 }); assert.deepEqual(only(b).votes, { bob: 1 });
  a.redo(); b.receiveOperation(aOps[2]);
  assert.deepEqual(only(a).votes, { bob: 1, alice: 1 });
});

test('project persistence is isolated and preserves clocks and tombstones on reload', () => {
  const storage = new MemoryStorage(); const repository = new LocalBoardRepository({ storage });
  const a = store(document(), { storage }); const operations = captured(a);
  a.updateObject('note-1', { text: 'Sauvegardé' }); a.removeObject('note-1');
  const second = store(createBoard({ id: 'second-board', title: 'Autre' }), { storage }); second.setTitle('Autre projet');
  assert.equal(repository.list().length, 2);
  const restored = store(repository.load('test-board'), { storage });
  assert.equal(restored.board.objects.length, 0);
  restored.receiveOperation(operations[0]); assert.equal(restored.board.objects.length, 0);
  assert.equal(repository.load('second-board').title, 'Autre projet');
  repository.delete('second-board'); assert.equal(repository.list().length, 1); assert.equal(repository.load('second-board'), null);
});

test('a stale clock envelope never overwrites a newer successfully saved project snapshot', () => {
  const storage = new MemoryStorage(); const repository = new LocalBoardRepository({ storage });
  const instance = store(document(), { storage });
  storage.failState = true; instance.setTitle('Sauvegarde partielle');
  assert.equal(instance.lastSaved, false); assert.equal(repository.load(instance.id).title, 'Sauvegarde partielle');
  const reopened = store(repository.load(instance.id), { storage });
  assert.equal(reopened.board.title, 'Sauvegarde partielle');
});

test('storage denial leaves the application editable and reports save failure', () => {
  const storage = { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Denied'); }, removeItem() { throw new Error('Denied'); } };
  const instance = store(document(), { storage });
  assert.doesNotThrow(() => instance.setTitle('Toujours disponible'));
  assert.equal(instance.board.title, 'Toujours disponible'); assert.equal(instance.lastSaved, false);
});

test('replacement removes stale fields and the whole import remains undoable', () => {
  const instance = store();
  const replacement = createBoard({ id: instance.id, title: 'Import', objects: [{ id: 'note-1', type: 'shape', x: 0, y: 0, width: 20, height: 20 }] });
  instance.replaceBoard(replacement);
  assert.equal(only(instance).type, 'shape'); assert.equal(Object.hasOwn(only(instance), 'text'), false); assert.equal(Object.hasOwn(only(instance), 'color'), false);
  instance.undo(); assert.equal(only(instance).type, 'note'); assert.equal(only(instance).text, 'Une idée'); assert.equal(only(instance).width, 200); assert.equal(instance.board.title, 'Atelier');
  instance.redo(); assert.equal(only(instance).type, 'shape'); assert.equal(Object.hasOwn(only(instance), 'text'), false);
});

test('JSON validation rejects active protocols, invalid geometry, duplicate IDs and prototype keys', () => {
  const withObject = object => ({ ...document(), objects: [object] });
  for (const src of ['javascript:alert(1)', 'http://example.com/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'file:///secret']) {
    assert.throws(() => validateBoard(withObject({ id: 'image', type: 'image', src })));
  }
  assert.equal(validateBoard(withObject({ id: 'image', type: 'image', src: 'https://example.com/a.png' })).objects[0].src, 'https://example.com/a.png');
  assert.equal(validateBoard(withObject({ id: 'image', type: 'image', src: 'data:image/png;base64,YQ==' })).objects.length, 1);
  assert.throws(() => validateBoard(withObject({ id: 'bad', type: 'note', x: NaN })));
  assert.throws(() => validateBoard({ ...document(), objects: [document().objects[0], document().objects[0]] }));
  assert.throws(() => validateBoard(withObject(JSON.parse('{"id":"bad","type":"note","__proto__":{"polluted":true}}'))));
  assert.throws(() => validateBoard({ ...document(), objects: Array.from({ length: DOCUMENT_LIMITS.objects + 1 }, (_, i) => ({ id: `n-${i}`, type: 'note' })) }));
  assert.equal({}.polluted, undefined);
});

test('aggregate document limit is checked before mutation, history or broadcasting', () => {
  const instance = store(createBoard({ id: 'large' })); const operations = captured(instance);
  const src = `data:image/png;base64,${'a'.repeat(7 * 1024 * 1024)}`;
  instance.addObject({ id: 'one', type: 'image', src }); instance.addObject({ id: 'two', type: 'image', src });
  assert.throws(() => instance.addObject({ id: 'three', type: 'image', src }));
  assert.equal(instance.board.objects.length, 2); assert.equal(operations.length, 2);
});

test('known text and color fields cannot inject incompatible JSON or CSS URLs; omitted geometry is normalized', () => {
  assert.throws(() => validateBoard(createBoard({ id: 'bad-frame', objects: [{ id: 'f', type: 'frame', text: { unexpected: true } }] })));
  assert.throws(() => createBoard({ id: 'bad-color', objects: [{ id: 'n', type: 'note', color: 'url(https://example.com/a)' }] }));
  const minimal = createBoard({ id: 'minimal', objects: [{ id: 'n', type: 'note', text: 'Simple' }] });
  assert.deepEqual({ x: minimal.objects[0].x, y: minimal.objects[0].y, width: minimal.objects[0].width, height: minimal.objects[0].height }, { x: 0, y: 0, width: 200, height: 170 });
  const source = store(createBoard({ id: 'minimal-remote' })); const target = store(createBoard({ id: 'minimal-remote' })); const operations = captured(source);
  source.addObject({ id: 'n', type: 'note', text: 'Simple' });
  const operation = structuredClone(operations[0]);
  for (const key of ['x', 'y', 'width', 'height']) delete operation.fields[key];
  assert.equal(target.receiveOperation(operation), true);
  assert.equal(target.board.objects[0].width, 200);
});

test('remote invalid operations and impossible clock jumps do not poison editing', () => {
  const instance = store(); const source = store(); const operations = captured(source); source.setTitle('Remote');
  const operation = operations[0];
  assert.equal(instance.receiveOperation({ ...operation, boardId: 'other' }), false);
  assert.equal(instance.receiveOperation({ ...operation, clock: { ...operation.clock, time: Number.MAX_SAFE_INTEGER } }), false);
  assert.equal(instance.receiveOperation({ ...operation, clock: { ...operation.clock, time: 1000000000000 } }), false);
  assert.doesNotThrow(() => instance.setTitle('Local'));
  assert.equal(instance.board.title, 'Local');
});

test('BroadcastChannel transport syncs operations and closing a store releases the channel', async () => {
  const initial = document(); const namespace = `test-${Date.now()}-${Math.random()}`;
  const a = new BoardStore(initial, { storage: null, namespace }); const b = new BoardStore(initial, { storage: null, namespace });
  try {
    a.updateObject('note-1', { text: 'Deux onglets' });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(only(b).text, 'Deux onglets');
    assert.equal(b.canUndo, false);
  } finally { a.destroy(); b.destroy(); }
  assert.equal(a.transport.channel, null);
  const unavailable = new BroadcastBoardTransport('board', { BroadcastChannel: null });
  assert.doesNotThrow(() => unavailable.send({ test: true })); unavailable.destroy();
});
