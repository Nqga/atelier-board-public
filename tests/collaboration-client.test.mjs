import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CollaborationClient } from '../dist/collaboration.js';
import { createAtelierServer } from '../server.mjs';

const nativeFetch = globalThis.fetch;
const user = name => ({ id: `guest-${name}`, name, color: '#123456' });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const expired = () => json({ code: 'SESSION_REQUIRED', message: 'Votre session a expiré.' }, 401);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fetchStub(t, handler) {
  const requests = [];
  globalThis.fetch = async (path, options) => { requests.push({ path, ...options }); return handler(path, options, requests); };
  t.after(() => { globalThis.fetch = nativeFetch; });
  return requests;
}

async function serverFixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-session-client-'));
  let clock = Date.now();
  const instance = await createAtelierServer({ dataDir, host: '127.0.0.1', port: 0, now: () => clock });
  const url = (await instance.start()).url;
  let cookie = '';
  const requests = fetchStub(t, async (path, options) => {
    const headers = { ...options.headers, Origin: url, ...(cookie ? { Cookie: cookie } : {}) };
    const response = await nativeFetch(url + path, { ...options, headers });
    const value = response.headers.getSetCookie().find(item => item.startsWith('atelier_'));
    if (value) cookie = value.split(';')[0];
    return response;
  });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { requests, expire: () => { clock += 366 * 86400000; }, forget: () => { cookie = ''; } };
}

test('a stale session can explicitly choose a new guest without recovering old memberships', async t => {
  const environment = await serverFixture(t), client = new CollaborationClient();
  await client.init();
  const first = await client.ensureSession('Alice');
  const board = await client.createBoard({ title: 'Projet privé', description: '', objects: [] });
  await client.refreshProjects(); assert.equal(client.projects.length, 1);
  environment.expire();
  const fresh = await client.setName('Benoît');
  assert.notEqual(fresh.id, first.id); assert.equal(fresh.name, 'Benoît');
  assert.deepEqual(client.projects, []);
  assert.deepEqual(await client.refreshProjects(), []);
  await assert.rejects(client.getBoard(board.board.id), error => error.status === 404);
  assert.equal(environment.requests.filter(request => request.path === '/api/session' && request.method === 'POST').length, 2);
  assert.equal(environment.requests.filter(request => request.path === '/api/session' && request.method === 'PATCH').length, 1);
});

test('a refused project write clears stale identity and is never replayed automatically', async t => {
  const environment = await serverFixture(t), client = new CollaborationClient();
  await client.init(); const first = await client.ensureSession('Alice');
  client.projects = [{ id: 'private-project' }]; environment.forget();
  await assert.rejects(client.createBoard({ title: 'Brouillon', objects: [] }), error => error.status === 401 && error.code === 'SESSION_REQUIRED');
  assert.equal(client.user, null); assert.deepEqual(client.projects, []);
  assert.equal(environment.requests.filter(request => request.path === '/api/boards' && request.method === 'POST').length, 1);
  assert.equal(environment.requests.filter(request => request.path === '/api/session' && request.method === 'POST').length, 1);
  const fresh = await client.ensureSession('Alice'); assert.notEqual(fresh.id, first.id);
  assert.equal(environment.requests.filter(request => request.path === '/api/boards' && request.method === 'POST').length, 1);
});

test('concurrent guest creation and name changes serialize without duplicate guests or deadlock', { timeout: 2000 }, async t => {
  const creation = deferred(); let current = null;
  const requests = fetchStub(t, async (_path, options) => {
    if (options.method === 'POST') { await creation.promise; current = user(JSON.parse(options.body).name); }
    if (options.method === 'PATCH') current = { ...current, name: JSON.parse(options.body).name };
    return json({ collaboration: true, user: current });
  });
  const client = new CollaborationClient(); client.available = true;
  const alice = client.ensureSession('Alice'), bob = client.ensureSession('Benoît'), final = client.setName('Camille');
  await Promise.resolve(); creation.resolve();
  assert.equal((await alice).name, 'Alice'); assert.equal((await bob).name, 'Benoît'); assert.equal((await final).name, 'Camille');
  assert.equal(client.user.name, 'Camille'); assert.equal(client.sessionPending, null);
  assert.deepEqual(requests.map(request => request.method), ['POST', 'GET', 'PATCH', 'PATCH']);
});

test('a browser that cannot retain its cookie stops after one POST and never writes a project', async t => {
  const requests = fetchStub(t, (_path, options) => json({ collaboration: true, user: options.method === 'POST' ? user('Alice') : null }));
  const client = new CollaborationClient(); client.available = true;
  await assert.rejects(client.createBoard({ title: 'Brouillon', objects: [] }), error => error.code === 'SESSION_COOKIE_MISSING' && /cookies/.test(error.message));
  assert.equal(client.user, null); assert.deepEqual(client.projects, []);
  assert.deepEqual(requests.map(request => [request.path, request.method]), [['/api/session', 'POST'], ['/api/session', 'GET']]);
});

test('an origin refusal stays distinct from expired sessions and does not create another guest', async t => {
  const requests = fetchStub(t, () => json({ code: 'ORIGIN_FORBIDDEN', message: 'L’adresse du serveur ne correspond pas.' }, 403));
  const client = new CollaborationClient(); client.available = true; client.user = user('Alice'); client.projects = [{ id: 'private-project' }];
  await assert.rejects(client.setName('Benoît'), error => error.code === 'ORIGIN_FORBIDDEN' && error.status === 403);
  assert.equal(client.user.name, 'Alice'); assert.equal(client.projects.length, 1);
  assert.deepEqual(requests.map(request => request.method), ['PATCH']);
});

test('failed session discovery removes stale identity and preserves the diagnostic for the next explicit action', async t => {
  fetchStub(t, () => json({ code: 'ORIGIN_FORBIDDEN', message: 'Vérifiez l’adresse et le protocole du serveur.' }, 403));
  const client = new CollaborationClient(); client.user = user('Alice'); client.projects = [{ id: 'private-project' }];
  assert.equal(await client.init(), null); assert.equal(client.available, false); assert.equal(client.user, null); assert.deepEqual(client.projects, []);
  await assert.rejects(client.ensureSession('Alice'), error => error.code === 'ORIGIN_FORBIDDEN' && /protocole/.test(error.message));
});

test('an older anonymous discovery cannot overwrite a successfully verified new guest', async t => {
  const discovery = deferred(); let reads = 0;
  fetchStub(t, (_path, options) => options.method === 'POST' ? json({ user: user('Alice') }) : ++reads === 1 ? discovery.promise : json({ user: user('Alice'), collaboration: true }));
  const client = new CollaborationClient(); client.available = true;
  const pending = client.init(); await client.ensureSession('Alice');
  discovery.resolve(json({ user: null, collaboration: true })); await pending;
  assert.equal(client.user.id, user('Alice').id); assert.equal(client.available, true);
});

test('an old protected response cannot erase a newly established guest or restore old projects', async t => {
  const oldBoards = deferred(); let current = user('Alice');
  fetchStub(t, (path, options) => {
    if (path === '/api/boards') return oldBoards.promise;
    if (options.method === 'POST') current = user('Benoît');
    return json({ user: current, collaboration: true });
  });
  const client = new CollaborationClient(); client.available = true; client.user = current;
  const pending = client.refreshProjects(); current = null; await client.init(); await client.ensureSession('Benoît');
  oldBoards.resolve(expired()); await assert.rejects(pending, error => error.code === 'SESSION_REQUIRED');
  assert.equal(client.user.name, 'Benoît'); assert.deepEqual(client.projects, []);
});

test('a late old project list cannot repopulate memberships after the session changes', async t => {
  const oldBoards = deferred();
  fetchStub(t, path => path === '/api/boards' ? oldBoards.promise : json({ user: null, collaboration: true }));
  const client = new CollaborationClient(); client.available = true; client.user = user('Alice');
  const pending = client.refreshProjects(); await client.init();
  oldBoards.resolve(json({ boards: [{ id: 'old-private-board' }] })); assert.deepEqual(await pending, []);
});

test('session discovery also preserves its own 401 diagnostic without guest creation loops', async t => {
  const requests = fetchStub(t, expired), client = new CollaborationClient();
  client.available = true; client.user = user('Alice');
  await client.init(); assert.equal(client.user, null); assert.equal(client.available, false);
  assert.equal(client.lastError.code, 'SESSION_REQUIRED');
  await assert.rejects(client.ensureSession('Alice'), error => error.code === 'SESSION_REQUIRED');
  assert.equal(requests.every(request => request.method === 'GET'), true);
});
