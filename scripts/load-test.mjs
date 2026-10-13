#!/usr/bin/env node
/**
 * Isolated collaboration benchmark. The server runs in a separate process on
 * loopback, with a new temporary database; this script never targets a live site.
 */
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createAtelierServer } from '../server.mjs';
import { DEFAULT_CAPACITY } from '../server/capacity.mjs';
import { Y, boardFromDoc, decodeBase64, encodeBase64, replaceYText } from '../dist/shared-model.js';

const RATE = 3;
const TIMEOUT = 15000;
const round = value => Math.round(value * 100) / 100;
const mib = bytes => round(bytes / 1024 ** 2);
const help = `Test de charge isolé d’Atelier Board (Node 24+).
Usage : npm run load:test -- [--participants 50] [--duration 10] [--boards 1] [--board-limit nombre] [--json chemin.json]

Le propriétaire compte parmi les participants. Chaque participant ouvre une
session distincte, rejoint son projet et envoie au plus ${RATE} modifications/s.
Une nouvelle base temporaire et un serveur local sont supprimés en fin de test.
Aucune adresse externe n’est acceptée. Ce test local ne garantit pas la capacité
d’un serveur distant, et ne mesure ni le rendu navigateur ni la latence réseau.
Bornes : 1–500 participants, 1–120 secondes, 1–20 projets (≤ participants).
Le serveur de test conserve les limites de l’application (${DEFAULT_CAPACITY.maxConnectionsPerBoard} connexions/projet).
--board-limit (1–500) change explicitement cette seule limite du serveur isolé.
Exemple pour comparer 100 participants sur un seul projet :
npm run load:test -- --participants 100 --boards 1 --board-limit 100`;

function parseArguments(args) {
  const config = { participants: 50, duration: 10, boards: 1, boardLimit: null, json: null };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return null;
    const key = { '--participants': 'participants', '--duration': 'duration', '--boards': 'boards', '--board-limit': 'boardLimit', '--json': 'json' }[argument];
    if (!key) throw new Error(`Option inconnue : ${argument}. Utilisez --help.`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Valeur manquante pour ${argument}.`);
    if (key === 'json') config.json = resolve(value);
    else {
      if (!/^[1-9]\d*$/.test(value)) throw new Error(`${argument} doit être un entier positif.`);
      config[key] = Number(value);
    }
  }
  if (config.participants > 500 || config.duration > 120 || config.boards > 20 || config.boards > config.participants || config.boardLimit > 500) throw new Error('Paramètres hors bornes. Utilisez --help.');
  return config;
}

async function worker() {
  let app, dataDir, capacity, sample, histogram, peakRss, cpuStart, measuredAt;
  const stopMetrics = () => {
    clearInterval(sample);
    const cpu = process.cpuUsage(cpuStart);
    histogram.disable();
    return {
      measurementSeconds: round((performance.now() - measuredAt) / 1000),
      peakRssMiB: mib(Math.max(peakRss, process.memoryUsage().rss)),
      cpuMilliseconds: round((cpu.user + cpu.system) / 1000),
      eventLoopDelayMilliseconds: {
        p50: round(histogram.percentile(50) / 1e6), p95: round(histogram.percentile(95) / 1e6),
        p99: round(histogram.percentile(99) / 1e6), max: round(histogram.max / 1e6),
      },
    };
  };
  process.on('message', async message => {
    try {
      let result;
      if (message.command === 'start') {
        if (app) throw new Error('Serveur de test déjà démarré.');
        dataDir = message.dataDir;
        capacity = message.boardLimit === undefined ? undefined : { maxConnectionsPerBoard: message.boardLimit };
        app = await createAtelierServer({ host: '127.0.0.1', port: 0, dataDir, ...(capacity ? { capacity } : {}) });
        result = await app.start();
      } else if (message.command === 'restart') {
        await app.close();
        app = await createAtelierServer({ host: '127.0.0.1', port: 0, dataDir, ...(capacity ? { capacity } : {}) });
        result = await app.start();
      } else if (message.command === 'measure') {
        peakRss = process.memoryUsage().rss;
        cpuStart = process.cpuUsage(); measuredAt = performance.now();
        histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable();
        sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 25);
        result = { started: true };
      } else if (message.command === 'metrics') result = stopMetrics();
      else if (message.command === 'stop') {
        clearInterval(sample); histogram?.disable();
        await app?.close(); result = { stopped: true };
      } else throw new Error('Commande de test inconnue.');
      process.send?.({ id: message.id, result });
    } catch (error) { process.send?.({ id: message.id, error: error.message }); }
  });
  process.once('disconnect', async () => { clearInterval(sample); await app?.close(); process.exit(); });
}

function childServer() {
  const child = fork(import.meta.filename, ['--worker'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const requests = new Map();
  child.on('message', message => {
    const pending = requests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer); requests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
  });
  const fail = error => {
    for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    requests.clear();
  };
  child.on('error', fail);
  child.on('exit', code => fail(new Error(`Le serveur de test s’est arrêté (${code}).`)));
  return {
    request(command, extra = {}) {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => { requests.delete(id); reject(new Error(`Délai dépassé : ${command}.`)); }, TIMEOUT);
        requests.set(id, { resolve, reject, timer });
        child.send({ id, command, ...extra }, error => { if (error) fail(error); });
      });
    },
    async close() {
      try { await this.request('stop'); } catch { /* The original failure remains in the report. */ }
      if (child.connected) child.disconnect();
      if (child.exitCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited; clearTimeout(timer);
      }
    },
  };
}

async function concurrent(items, limit, action) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await action(items[next++]);
  }));
}

class Guest {
  constructor(url, index) { this.url = url; this.index = index; this.cookie = ''; }
  async request(path, method = 'GET', body) {
    const headers = { Origin: this.url };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(this.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT) });
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('atelier_'));
    if (cookie) this.cookie = cookie.split(';')[0];
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.message || `HTTP ${response.status}`), { code: data.code || `HTTP_${response.status}` });
    return data;
  }
  async session() {
    const session = await this.request('/api/session', 'POST', { name: `Charge ${this.index}` });
    this.user = session.user;
    const retained = await this.request('/api/session');
    if (!this.cookie || !this.user?.id || retained.user?.id !== this.user.id) throw Object.assign(new Error('La session créée n’est pas conservée.'), { code: 'SESSION_NOT_RETAINED' });
  }
}

class Actor {
  constructor(guest, boardId) {
    this.guest = guest; this.boardId = boardId; this.doc = new Y.Doc();
    this.pending = new Map(); this.revision = 0; this.steps = 0;
  }
  async connect() {
    return new Promise((resolve, reject) => {
      const socket = this.socket = new WebSocket(`${this.guest.url.replace(/^http/, 'ws')}/api/boards/${this.boardId}/live`, { headers: { Cookie: this.guest.cookie, Origin: this.guest.url } });
      let connected = false;
      const timer = setTimeout(() => { socket.terminate(); reject(Object.assign(new Error('Connexion WebSocket expirée.'), { code: 'CONNECT_TIMEOUT' })); }, TIMEOUT);
      const refused = error => { if (!connected) { clearTimeout(timer); reject(error); } };
      socket.on('message', raw => {
        try {
          const message = JSON.parse(raw.toString());
          if (message.type === 'sync' || message.type === 'update') {
            Y.applyUpdate(this.doc, decodeBase64(message.state || message.update));
            this.revision = Math.max(this.revision, message.revision);
            if (!connected && message.type === 'sync') { connected = true; clearTimeout(timer); resolve(this); }
          } else if (message.type === 'ack' || message.type === 'error') {
            const pending = this.pending.get(message.id);
            if (pending) {
              clearTimeout(pending.timer); this.pending.delete(message.id);
              if (message.type === 'ack') {
                this.revision = Math.max(this.revision, message.revision);
                pending.resolve(performance.now() - pending.sentAt);
              } else pending.reject(Object.assign(new Error(message.message), { code: message.code }));
            } else if (message.type === 'error') refused(Object.assign(new Error(message.message), { code: message.code }));
          }
        } catch (error) { refused(error); socket.terminate(); }
      });
      socket.on('error', refused);
      socket.on('unexpected-response', (_, response) => { refused(Object.assign(new Error(`Connexion refusée : ${response.statusCode}`), { code: `HTTP_${response.statusCode}` })); socket.terminate(); });
      socket.on('close', () => {
        refused(Object.assign(new Error('Connexion fermée avant synchronisation.'), { code: 'SOCKET_CLOSED' }));
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Object.assign(new Error('Connexion interrompue.'), { code: 'SOCKET_CLOSED' })); }
        this.pending.clear();
      });
    });
  }
  edit(step) {
    const vector = Y.encodeStateVector(this.doc);
    const index = this.guest.index;
    this.doc.transact(() => {
      const objects = this.doc.getMap('objects');
      const object = objects.get(`actor-${index}`);
      object.set('x', index * 10 + step); object.set('y', step);
      replaceYText(object.get('text'), `Participant ${index} : ${step}`);
      if (step === 1) {
        const common = objects.get('ensemble');
        const text = common.get('text'); text.insert(text.length, `#${index};`);
        common.get('votes').set(this.guest.user.id, 1);
      }
    });
    const update = encodeBase64(Y.encodeStateAsUpdate(this.doc, vector));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('Confirmation d’enregistrement expirée.'), { code: 'ACK_TIMEOUT' })); }, TIMEOUT);
      this.pending.set(id, { resolve, reject, timer, sentAt: performance.now() });
      this.socket.send(JSON.stringify({ type: 'update', id, update }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(Object.assign(error, { code: 'SEND_FAILED' })); }
      });
    });
  }
  close() { this.socket?.terminate(); this.doc.destroy(); }
}

function seed(indices, number) {
  const note = (id, text, x = 0) => ({ id, type: 'note', text, x, y: 0, width: 200, height: 170, color: '#ffdd88', votes: {} });
  return { title: `Test de charge ${number}`, description: 'Données temporaires du benchmark', objects: [note('ensemble', 'Participants : '), ...indices.map(index => note(`actor-${index}`, '', index * 10))] };
}

function canonical(board) {
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  return JSON.stringify(sorted({ ...board, updatedAt: '', objects: [...board.objects].sort((a, b) => a.id.localeCompare(b.id)) }));
}

async function environment() {
  const readLimit = async path => { try { return (await readFile(path, 'utf8')).trim(); } catch { return null; } };
  const cpu = (await readLimit('/sys/fs/cgroup/cpu.max'))?.split(' ');
  const memory = await readLimit('/sys/fs/cgroup/memory.max');
  return { nodeVersion: process.version, platform: process.platform, architecture: process.arch, availableParallelism: availableParallelism(), cpuLimitCores: cpu && cpu[0] !== 'max' ? round(Number(cpu[0]) / Number(cpu[1])) : null, memoryLimitMiB: memory && memory !== 'max' ? mib(Number(memory)) : null };
}

async function benchmark(config) {
  const report = {
    schemaVersion: 1, ok: false,
    configuration: {
      participants: config.participants, boards: config.boards, durationSeconds: config.duration,
      updatesPerSecondPerParticipant: RATE, isolated: true,
      serverLimits: { ...DEFAULT_CAPACITY, ...(config.boardLimit === null ? {} : { maxConnectionsPerBoard: config.boardLimit }) },
      capacityOverrides: config.boardLimit === null ? {} : { maxConnectionsPerBoard: config.boardLimit },
    },
    environment: await environment(),
    admission: { sessions: { requested: config.participants, accepted: 0 }, invitations: { requested: config.participants - 1, accepted: 0 }, connections: { requested: config.participants, attempted: 0, accepted: 0 } },
    updates: { sent: 0, acknowledged: 0, failed: 0, errorsByCode: {} },
    limitations: ['Serveur et générateur sur la même machine, réseau loopback.', 'Mesure de petits documents ; aucun rendu navigateur, image ou trafic réseau distant.', 'Le résultat décrit ce scénario et ne garantit pas une capacité de production.'],
  };
  const recordError = error => { const code = error.code || 'TEST_FAILURE'; report.updates.errorsByCode[code] = (report.updates.errorsByCode[code] || 0) + 1; };
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-load-'));
  const server = childServer();
  const actors = [], latencies = [], boards = [];
  const stop = new AbortController();
  const interrupted = () => stop.abort(new Error('Test interrompu.'));
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  const startedAt = performance.now();
  try {
    const { url } = await server.request('start', { dataDir, ...(config.boardLimit === null ? {} : { boardLimit: config.boardLimit }) });
    const guests = Array.from({ length: config.participants }, (_, index) => new Guest(url, index));
    const owner = guests[0];
    await owner.session(); report.admission.sessions.accepted++;
    for (let number = 0; number < config.boards; number++) {
      const indices = guests.filter(guest => guest.index % config.boards === number).map(guest => guest.index);
      const initial = await owner.request('/api/boards', 'POST', { board: seed(indices, number) });
      const invitation = await owner.request(`/api/boards/${initial.board.id}/invitations`, 'POST', { role: 'editor' });
      boards.push({ id: initial.board.id, token: invitation.token, indices });
    }
    await concurrent(guests.slice(1), 10, async guest => {
      try {
        await guest.session(); report.admission.sessions.accepted++;
        await guest.request('/api/invitations/join', 'POST', { token: boards[guest.index % config.boards].token });
        guest.joined = true; report.admission.invitations.accepted++;
      } catch (error) { recordError(error); }
    });
    owner.joined = true;
    await concurrent(guests.filter(guest => guest.joined), 10, async guest => {
      const actor = new Actor(guest, boards[guest.index % config.boards].id);
      actors.push(actor); report.admission.connections.attempted++;
      try { await actor.connect(); actor.connected = true; report.admission.connections.accepted++; }
      catch (error) { recordError(error); }
    });
    report.setupSeconds = round((performance.now() - startedAt) / 1000);
    await server.request('measure');
    const loadStartedAt = performance.now(), deadline = loadStartedAt + config.duration * 1000;
    await Promise.all(actors.filter(actor => actor.connected).map(async (actor, index) => {
      let nextAt = loadStartedAt + index * 1000 / RATE / Math.max(1, report.admission.connections.accepted);
      while (!stop.signal.aborted && nextAt < deadline && actor.steps < config.duration * RATE) {
        if (performance.now() < nextAt) await delay(Math.ceil(nextAt - performance.now()), undefined, { signal: stop.signal });
        if (performance.now() >= deadline) break;
        const sentAt = performance.now(); report.updates.sent++;
        try {
          const latency = await actor.edit(actor.steps + 1);
          actor.steps++; report.updates.acknowledged++; latencies.push(latency);
        } catch (error) { report.updates.failed++; recordError(error); break; }
        nextAt = sentAt + 1000 / RATE;
      }
    }));
    if (performance.now() < deadline) await delay(Math.ceil(deadline - performance.now()), undefined, { signal: stop.signal });
    const loadSeconds = (performance.now() - loadStartedAt) / 1000;
    report.loadSeconds = round(loadSeconds);
    report.updates.acknowledgedPerSecond = round(report.updates.acknowledged / loadSeconds);
    report.server = await server.request('metrics');
    latencies.sort((a, b) => a - b);
    const percentile = fraction => latencies.length ? round(latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * fraction) - 1)]) : null;
    report.acknowledgementMilliseconds = { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: latencies.length ? round(latencies.at(-1)) : null };

    // Reopen SQLite before reading the authoritative snapshot. An ACK alone
    // does not constitute this benchmark’s proof of persistence across restart.
    owner.url = (await server.request('restart')).url;
    const consistency = report.consistency = { restartVerified: true, durableBoardsVerified: 0, matchingClients: 0, actorStatesVerified: 0, concurrentTextMarkersVerified: 0, ownVotesVerified: 0, revisionsMatch: true, passed: false };
    for (const board of boards) {
      const durable = await owner.request(`/api/boards/${board.id}`);
      const doc = new Y.Doc(); Y.applyUpdate(doc, decodeBase64(durable.state));
      const expected = canonical(boardFromDoc(doc, board.id)); doc.destroy();
      const members = actors.filter(actor => actor.connected && actor.boardId === board.id);
      const limit = performance.now() + TIMEOUT;
      while (members.some(actor => canonical(boardFromDoc(actor.doc, board.id)) !== expected) && performance.now() < limit && !stop.signal.aborted) await delay(25);
      consistency.durableBoardsVerified++;
      for (const actor of members) {
        if (canonical(boardFromDoc(actor.doc, board.id)) === expected) consistency.matchingClients++;
        if (actor.revision !== durable.revision) consistency.revisionsMatch = false;
        const object = durable.board.objects.find(item => item.id === `actor-${actor.guest.index}`);
        if (object?.x === actor.guest.index * 10 + actor.steps && object?.y === actor.steps && object?.text === `Participant ${actor.guest.index} : ${actor.steps}`) consistency.actorStatesVerified++;
        const common = durable.board.objects.find(item => item.id === 'ensemble');
        if (common?.text.split(`#${actor.guest.index};`).length === 2) consistency.concurrentTextMarkersVerified++;
        if (common?.votes?.[actor.guest.user.id] === 1) consistency.ownVotesVerified++;
      }
      if (durable.revision !== members.reduce((sum, actor) => sum + actor.steps, 0)) consistency.revisionsMatch = false;
    }
    consistency.passed = consistency.durableBoardsVerified === config.boards && consistency.revisionsMatch && ['matchingClients', 'actorStatesVerified', 'concurrentTextMarkersVerified', 'ownVotesVerified'].every(key => consistency[key] === config.participants);
    report.ok = consistency.passed && report.updates.sent === report.updates.acknowledged && !Object.keys(report.updates.errorsByCode).length && !stop.signal.aborted;
  } catch (error) { recordError(error); report.failure = error.message; }
  finally {
    for (const actor of actors) actor.close();
    await server.close(); await rm(dataDir, { recursive: true, force: true });
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
  }
  report.totalSeconds = round((performance.now() - startedAt) / 1000);
  for (const admission of Object.values(report.admission)) admission.rejected = (admission.attempted ?? admission.requested) - admission.accepted;
  report.admission.connections.notAttempted = config.participants - report.admission.connections.attempted;
  return report;
}

if (process.argv[2] === '--worker' && process.send) await worker();
else {
  try {
    const config = parseArguments(process.argv.slice(2));
    if (!config) console.log(help);
    else {
      const report = await benchmark(config);
      if (config.json) await writeFile(config.json, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      console.log(`Test isolé : ${config.participants} participants, ${config.boards} projet(s), ${config.duration} s, ${RATE} modifications/s/personne.`);
      if (config.boardLimit !== null) console.log(`Limite du serveur isolé modifiée explicitement : ${config.boardLimit} connexions/projet.`);
      console.log(`Connexions : ${report.admission.connections.accepted}/${config.participants}. Enregistrements confirmés : ${report.updates.acknowledged}/${report.updates.sent} (${report.updates.acknowledgedPerSecond ?? 0}/s).`);
      if (report.server) console.log(`ACK p50/p95/p99 : ${report.acknowledgementMilliseconds.p50}/${report.acknowledgementMilliseconds.p95}/${report.acknowledgementMilliseconds.p99} ms. Serveur : RSS max ${report.server.peakRssMiB} Mio, retard event loop max ${report.server.eventLoopDelayMilliseconds.max} ms.`);
      console.log(`Convergence et état durable : ${report.ok ? 'VALIDÉS' : 'ÉCHEC'}. ${config.json ? `Rapport : ${config.json}` : 'Utilisez --json chemin.json pour conserver les mesures.'}`);
      if (!report.ok) console.error(JSON.stringify({ errorsByCode: report.updates.errorsByCode, failure: report.failure, consistency: report.consistency }));
      process.exitCode = report.ok ? 0 : 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
