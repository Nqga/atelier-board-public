/**
 * Atelier Board document store.
 * Mutations are small, serializable operations. A future server transport can
 * subscribe to them and feed authorized remote operations to receiveOperation.
 */
export const STORAGE_NAMESPACE = 'atelier-board:v1';
export const DOCUMENT_LIMITS = Object.freeze({ objects: 3000, text: 20000, image: 8 * 1024 * 1024, bytes: 20 * 1024 * 1024 });
const TYPES = new Set(['note', 'text', 'shape', 'frame', 'connector', 'draw', 'image', 'link']);
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const ZERO_CLOCK = Object.freeze({ time: 0, actor: '', id: '' });
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const isoNow = () => new Date().toISOString();
const finite = (value, name, limit = 100000000) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) throw new Error(`${name} doit être un nombre fini.`);
  return value;
};
const validId = (value, name = 'Identifiant') => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) throw new Error(`${name} invalide.`);
  return value;
};
const validText = (value, name, max = DOCUMENT_LIMITS.text) => {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name} invalide ou trop long.`);
  return value;
};
function plain(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error(`${name} doit être un objet JSON.`);
  return value;
}
function cleanJSON(value, depth = 0) {
  if (depth > 8) throw new Error('Document trop imbriqué.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return validText(value, 'Texte');
  if (typeof value === 'number') return finite(value, 'Valeur', Number.MAX_SAFE_INTEGER);
  if (Array.isArray(value)) {
    if (value.length > 10000) throw new Error('Liste trop longue.');
    return value.map(item => cleanJSON(item, depth + 1));
  }
  plain(value, 'Valeur');
  const result = {};
  const entries = Object.entries(value);
  if (entries.length > 1000) throw new Error('Objet trop volumineux.');
  for (const [key, item] of entries) {
    if (FORBIDDEN.has(key) || key.length > 128) throw new Error('Clé JSON non autorisée.');
    result[key] = cleanJSON(item, depth + 1);
  }
  return result;
}
function imageSource(value) {
  validText(value, 'Image', DOCUMENT_LIMITS.image);
  if (/^\/api\/boards\/[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}\/assets\/[a-f0-9-]{36}$/.test(value)) return value;
  if (/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* Report one useful validation error below. */ }
  throw new Error('Image : utilisez une URL HTTPS ou une image PNG, JPEG, WebP ou GIF.');
}
function linkURL(value) {
  validText(value, 'Lien', 4000);
  if (value === '') return '';
  try {
    const url = new URL(value);
    if (['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Invalid URL. */ }
  throw new Error('Lien non autorisé.');
}
function cleanFields(input) {
  plain(input, 'Objet');
  if (Object.keys(input).length > 100) throw new Error('Objet trop volumineux.');
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN.has(key) || key.length > 128) throw new Error('Clé non autorisée.');
    if (value === undefined) continue;
    if (key === 'id') result.id = validId(value);
    else if (key === 'type') {
      if (!TYPES.has(value)) throw new Error(`Type d'objet non pris en charge : ${String(value).slice(0, 80)}`);
      result.type = value;
    } else if (key === 'src') result.src = imageSource(value);
    else if (key === 'url' || key === 'href') result[key] = linkURL(value);
    else if (['text', 'content', 'title', 'author', 'align', 'shape'].includes(key)) {
      result[key] = validText(value, key, key === 'author' ? 128 : key === 'shape' || key === 'align' ? 32 : DOCUMENT_LIMITS.text);
      if (key === 'shape' && !['rectangle', 'ellipse', 'diamond'].includes(value)) throw new Error('Forme non prise en charge.');
    } else if (['color', 'fill', 'stroke', 'strokeColor'].includes(key)) {
      validText(value, key, 128);
      if (!/^(?:#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+-]+\)|[a-z]+)$/i.test(value)) throw new Error('Couleur non autorisée.');
      result[key] = value;
    } else if (key === 'fontWeight') {
      if (typeof value === 'number') result[key] = finite(value, key, 1000);
      else {
        validText(value, key, 32);
        if (!/^(?:normal|bold|bolder|lighter|[1-9]00)$/i.test(value)) throw new Error('Épaisseur du texte invalide.');
        result[key] = value;
      }
    }
    else if (['x', 'y', 'rotation', 'zIndex', 'z', 'fontSize', 'strokeWidth', 'opacity'].includes(key)) result[key] = finite(value, key);
    else if (['width', 'height'].includes(key)) {
      finite(value, key, 10000000);
      if (value < 1) throw new Error(`${key} doit être positif.`);
      result[key] = value;
    } else if (key === 'from' || key === 'to') result[key] = validId(value, key);
    else if (key === 'points') {
      if (!Array.isArray(value) || value.length > 10000) throw new Error('Tracé invalide ou trop long.');
      result.points = value.map(point => { plain(point, 'Point'); return { x: finite(point.x, 'x'), y: finite(point.y, 'y') }; });
    } else if (key === 'votes') {
      plain(value, 'Votes');
      result.votes = {};
      if (Object.keys(value).length > 1000) throw new Error('Trop de votes.');
      for (const [actor, count] of Object.entries(value)) {
        validId(actor, 'Votant');
        if (FORBIDDEN.has(actor) || !Number.isSafeInteger(count) || count < 0 || count > 10000) throw new Error('Vote invalide.');
        result.votes[actor] = count;
      }
    } else result[key] = cleanJSON(value);
  }
  return result;
}
function cleanObject(input) {
  const object = cleanFields(input);
  validId(object.id);
  if (!TYPES.has(object.type)) throw new Error("Type d'objet manquant ou invalide.");
  if (object.type === 'image' && !object.src) throw new Error('Source de l’image manquante.');
  if (object.type === 'connector' && (!object.from || !object.to)) throw new Error('Connexion incomplète.');
  if (object.type === 'draw' && !object.points) throw new Error('Points du tracé manquants.');
  const dimensions = { note: [200, 170], text: [300, 70], shape: [180, 140], frame: [520, 400], connector: [1, 1] };
  const [width, height] = dimensions[object.type] || [200, 170];
  object.x ??= 0; object.y ??= 0; object.width ??= width; object.height ??= height;
  return object;
}
/** Validate and clone a portable document. Unknown safe JSON attributes survive. */
export function validateBoard(value) {
  plain(value, 'Tableau');
  if (!Array.isArray(value.objects) || value.objects.length > DOCUMENT_LIMITS.objects) throw new Error(`Le tableau accepte au maximum ${DOCUMENT_LIMITS.objects} objets.`);
  const ids = new Set();
  const objects = value.objects.map(object => {
    const clean = cleanObject(object);
    if (ids.has(clean.id)) throw new Error('Deux objets ont le même identifiant.');
    ids.add(clean.id);
    return clean;
  });
  const updatedAt = value.updatedAt || isoNow();
  if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) throw new Error('Date de modification invalide.');
  const board = {
    id: validId(value.id),
    title: validText(value.title ?? 'Tableau sans titre', 'Titre', 200),
    description: validText(value.description ?? '', 'Description', 4000),
    objects,
    updatedAt: new Date(updatedAt).toISOString(),
  };
  if (JSON.stringify(board).length > DOCUMENT_LIMITS.bytes) throw new Error('Le tableau dépasse la taille maximale de 20 Mo.');
  return board;
}
export function createBoard(options = {}) {
  return validateBoard({ id: uuid(), title: 'Tableau sans titre', description: '', objects: [], updatedAt: isoNow(), ...options });
}
function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}
function safeRead(storage, key) {
  try { const value = storage?.getItem(key); return value ? JSON.parse(value) : null; } catch { return null; }
}
function safeWrite(storage, key, value) {
  try { if (!storage) return false; storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
/** Local project directory. Storage failures never prevent editing. */
export class LocalBoardRepository {
  constructor({ storage = defaultStorage(), namespace = STORAGE_NAMESPACE } = {}) { this.storage = storage; this.namespace = namespace; }
  _key(id) { return `${this.namespace}:project:${validId(id)}`; }
  list() {
    const index = safeRead(this.storage, `${this.namespace}:projects`) || [];
    if (!Array.isArray(index)) return [];
    return index.filter(item => item && typeof item.id === 'string').flatMap(item => {
      try {
        const board = this.load(item.id);
        return board ? [{ id: board.id, title: board.title, description: board.description, updatedAt: board.updatedAt, objectCount: board.objects.length }] : [];
      } catch { return []; }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  load(id) {
    const stored = safeRead(this.storage, this._key(id));
    if (!stored) return null;
    try { return validateBoard(stored); } catch { return null; }
  }
  save(value) {
    const board = validateBoard(value);
    const saved = safeWrite(this.storage, this._key(board.id), board);
    const previous = safeRead(this.storage, `${this.namespace}:projects`);
    const index = Array.isArray(previous) ? previous.filter(item => item && item.id !== board.id) : [];
    index.push({ id: board.id });
    return safeWrite(this.storage, `${this.namespace}:projects`, index) && saved;
  }
  delete(id) {
    validId(id);
    try {
      this.storage?.removeItem(this._key(id));
      this.storage?.removeItem(`${this.namespace}:state:${id}`);
      const previous = safeRead(this.storage, `${this.namespace}:projects`);
      return safeWrite(this.storage, `${this.namespace}:projects`, Array.isArray(previous) ? previous.filter(item => item?.id !== id) : []);
    } catch { return false; }
  }
}
const compareString = (a, b) => a === b ? 0 : a < b ? -1 : 1;
const compareClock = (a = ZERO_CLOCK, b = ZERO_CLOCK) => a.time - b.time || compareString(a.actor, b.actor) || compareString(a.id, b.id);
function cleanClock(value) {
  plain(value, 'Horloge');
  if (!Number.isSafeInteger(value.time) || value.time < 0 || value.time > Number.MAX_SAFE_INTEGER - 1000000) throw new Error('Horloge invalide.');
  return { time: value.time, actor: validId(value.actor, 'Acteur'), id: validId(value.id, 'Opération') };
}
function cleanOperation(value, boardId) {
  plain(value, 'Opération');
  if (value.version !== 1 || value.boardId !== boardId) throw new Error('Opération incompatible avec ce tableau.');
  const id = validId(value.id, 'Opération');
  const actor = validId(value.actor, 'Acteur');
  const clock = cleanClock(value.clock);
  if (clock.id !== id || clock.actor !== actor) throw new Error('Horloge incohérente.');
  const timestamp = value.timestamp;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) throw new Error('Date d’opération invalide.');
  const operation = { version: 1, boardId, id, actor, clock, timestamp: new Date(timestamp).toISOString(), kind: value.kind };
  if (value.kind === 'board.set') {
    plain(value.fields, 'Métadonnées');
    operation.fields = {};
    for (const [key, item] of Object.entries(value.fields)) {
      if (!['title', 'description'].includes(key)) throw new Error('Métadonnée non autorisée.');
      operation.fields[key] = validText(item, key, key === 'title' ? 200 : 4000);
    }
  } else if (value.kind === 'object.set') {
    operation.objectId = validId(value.objectId);
    operation.fields = cleanFields(value.fields || {});
    if ('id' in operation.fields) throw new Error('Identifiant d’objet immuable.');
    if (value.alive !== undefined) {
      if (value.alive !== true) throw new Error('Valeur de présence invalide.');
      operation.alive = true;
      const object = cleanObject({ id: operation.objectId, ...operation.fields });
      delete object.id;
      operation.fields = object;
    }
    if (!operation.alive && Object.hasOwn(operation.fields, 'type')) throw new Error('Le type d’objet est immuable.');
    operation.unset = value.unset ?? [];
    if (!Array.isArray(operation.unset) || operation.unset.length > 100 || operation.unset.some(key => typeof key !== 'string' || FORBIDDEN.has(key) || ['id', 'type', 'votes'].includes(key) || key.length > 128)) throw new Error('Champs à supprimer invalides.');
    operation.unsetVotes = value.unsetVotes ?? [];
    if (!Array.isArray(operation.unsetVotes) || operation.unsetVotes.length > 1000) throw new Error('Votes à supprimer invalides.');
    for (const actorId of operation.unsetVotes) validId(actorId, 'Votant');
  } else if (value.kind === 'object.delete') operation.objectId = validId(value.objectId);
  else throw new Error('Opération inconnue.');
  if (JSON.stringify(operation).length > DOCUMENT_LIMITS.image + DOCUMENT_LIMITS.text * 2) throw new Error('Opération trop volumineuse.');
  return operation;
}

/** Same-origin tabs only. A transport sends envelopes, never board snapshots. */
export class BroadcastBoardTransport {
  constructor(boardId, { namespace = STORAGE_NAMESPACE, BroadcastChannel = globalThis.BroadcastChannel } = {}) {
    this.listeners = new Set();
    this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`${namespace}:channel:${validId(boardId)}`) : null;
    if (this.channel) {
      this.channel.onmessage = event => { for (const fn of this.listeners) fn(event.data); };
      this.channel.unref?.();
    }
  }
  send(message) { try { this.channel?.postMessage(copy(message)); } catch { /* Offline transport does not block local edits. */ } }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  destroy() { this.listeners.clear(); this.channel?.close(); this.channel = null; }
}

export class BoardStore {
  constructor(initialBoard = createBoard(), options = {}) {
    const board = validateBoard(initialBoard);
    this.namespace = options.namespace || STORAGE_NAMESPACE;
    this.clientId = validId(options.clientId || uuid(), 'Client');
    this.actorId = validId(options.actorId || this.clientId, 'Acteur');
    this.repo = options.repository || new LocalBoardRepository({ storage: options.storage === undefined ? defaultStorage() : options.storage, namespace: this.namespace });
    this.storage = this.repo.storage;
    this.listeners = new Set(); this.operationListeners = new Set();
    this.history = []; this.redoHistory = []; this.records = new Map(); this.seen = new Set();
    this.lamport = 0; this.batchDepth = 0; this.batchEntries = []; this.batchLabel = ''; this.dirty = false; this.destroyed = false;
    this.lastSaved = false;
    this._seed(board);
    if (options.restore !== false) this._restore();
    this.transport = options.transport === false || options.sync === false ? null : (options.transport || new BroadcastBoardTransport(board.id, { namespace: this.namespace }));
    this.unsubscribeTransport = this.transport?.subscribe(message => this._receiveMessage(message));
    this._persist();
    // A peer responds with its known operation journal; no full snapshot merge.
    this.transport?.send({ type: 'hello', version: 1, boardId: this.id, clientId: this.clientId });
    for (const operation of this.journal) this.transport?.send({ type: 'operation', operation, clientId: this.clientId });
  }
  _seed(board) {
    this.id = board.id;
    this.metadata = { title: board.title, description: board.description };
    this.metadataClocks = { title: ZERO_CLOCK, description: ZERO_CLOCK };
    this.updatedAt = board.updatedAt;
    this.records.clear(); this.seen.clear(); this.journal = [];
    for (const object of board.objects) {
      const fields = copy(object); delete fields.id;
      this.records.set(object.id, { fields, clocks: Object.fromEntries(Object.keys(fields).map(key => [key, ZERO_CLOCK])), voteClocks: Object.fromEntries(Object.keys(fields.votes || {}).map(actor => [actor, ZERO_CLOCK])), alive: true, aliveClock: ZERO_CLOCK });
    }
  }
  get board() {
    return copy({ id: this.id, ...this.metadata, objects: [...this.records.entries()].filter(([, record]) => record.alive).map(([id, record]) => ({ id, ...record.fields })), updatedAt: this.updatedAt });
  }
  get canUndo() { return this.history.length > 0; }
  get canRedo() { return this.redoHistory.length > 0; }
  subscribe(fn) { if (typeof fn !== 'function') throw new TypeError('Callback attendu.'); this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onOperation(fn) { if (typeof fn !== 'function') throw new TypeError('Callback attendu.'); this.operationListeners.add(fn); return () => this.operationListeners.delete(fn); }
  _notify(source = 'local', label = '') {
    if (this.batchDepth) { this.dirty = true; return; }
    this._persist();
    const board = this.board;
    for (const fn of this.listeners) { try { fn(copy(board), { source, label }); } catch (error) { console.error('Board subscriber:', error); } }
  }
  _persist() {
    const envelope = { version: 1, board: this.board, lamport: this.lamport, metadataClocks: this.metadataClocks, records: [...this.records.entries()], journal: this.journal };
    const stateSaved = safeWrite(this.storage, `${this.namespace}:state:${this.id}`, envelope);
    try { this.lastSaved = this.repo.save(envelope.board) && stateSaved; }
    catch { this.lastSaved = false; }
    return this.lastSaved;
  }
  save() { return this._persist(); }
  _restore() {
    const envelope = safeRead(this.storage, `${this.namespace}:state:${this.id}`);
    if (!envelope || envelope.version !== 1) return;
    try {
      const board = validateBoard(envelope.board);
      if (board.id !== this.id || !Array.isArray(envelope.records)) return;
      // The project snapshot may have saved successfully while the larger
      // clock envelope exceeded storage quota. Never restore that older state.
      if (board.updatedAt < this.updatedAt || (board.updatedAt === this.updatedAt && JSON.stringify(board) !== JSON.stringify(this.board))) return;
      // Rebuild from the validated portable document, then replay the operation
      // journal so persisted field clocks and tombstones are preserved.
      const journal = Array.isArray(envelope.journal) ? envelope.journal.map(op => {
        const clean = cleanOperation(op, this.id);
        if (clean.clock.time > 1000000000000) throw new Error('Horloge persistée invalide.');
        return clean;
      }) : [];
      this._seed(board);
      for (const operation of journal) this._apply(operation);
    } catch { /* Corrupt state is ignored; the supplied document stays editable. */ }
  }
  _apply(operation) {
    if (this.seen.has(operation.id)) return false;
    this.lamport = Math.max(this.lamport, operation.clock.time);
    this.seen.add(operation.id);
    this.journal.push(copy(operation));
    let changed = false;
    if (operation.kind === 'board.set') {
      for (const [key, value] of Object.entries(operation.fields)) {
        if (compareClock(operation.clock, this.metadataClocks[key]) > 0) {
          this.metadata[key] = copy(value); this.metadataClocks[key] = operation.clock; changed = true;
        }
      }
    } else {
      let record = this.records.get(operation.objectId);
      if (!record) { record = { fields: {}, clocks: {}, voteClocks: {}, alive: false, aliveClock: ZERO_CLOCK }; this.records.set(operation.objectId, record); }
      if (operation.kind === 'object.delete') {
        if (compareClock(operation.clock, record.aliveClock) > 0) { record.alive = false; record.aliveClock = operation.clock; changed = true; }
      } else {
        if (operation.alive === true && compareClock(operation.clock, record.aliveClock) > 0) { record.alive = true; record.aliveClock = operation.clock; changed = true; }
        for (const [key, value] of Object.entries(operation.fields)) {
          if (key === 'votes') {
            record.fields.votes ||= {}; record.voteClocks ||= {};
            for (const [actor, count] of Object.entries(value)) {
              if (compareClock(operation.clock, record.voteClocks[actor]) > 0) { record.fields.votes[actor] = count; record.voteClocks[actor] = operation.clock; changed = true; }
            }
          } else if (compareClock(operation.clock, record.clocks[key]) > 0) { record.fields[key] = copy(value); record.clocks[key] = operation.clock; changed = true; }
        }
        for (const key of operation.unset || []) {
          if (compareClock(operation.clock, record.clocks[key]) > 0) { delete record.fields[key]; record.clocks[key] = operation.clock; changed = true; }
        }
        for (const actor of operation.unsetVotes || []) {
          record.voteClocks ||= {};
          if (compareClock(operation.clock, record.voteClocks[actor]) > 0) { if (record.fields.votes) delete record.fields.votes[actor]; record.voteClocks[actor] = operation.clock; changed = true; }
        }
      }
    }
    if (changed && operation.timestamp > this.updatedAt) this.updatedAt = operation.timestamp;
    return changed;
  }
  _perform(descriptor) {
    if (this.destroyed) throw new Error('Ce tableau est fermé.');
    descriptor = copy(descriptor);
    if (descriptor.kind === 'object.set' && descriptor.alive) {
      const previous = this.records.get(descriptor.objectId)?.fields || {};
      descriptor.unset = [...new Set([...(descriptor.unset || []), ...Object.keys(previous).filter(key => !Object.hasOwn(descriptor.fields, key) && !['type', 'votes'].includes(key))])];
      descriptor.unsetVotes = [...new Set([...(descriptor.unsetVotes || []), ...Object.keys(previous.votes || {}).filter(actor => !Object.hasOwn(descriptor.fields.votes || {}, actor))])];
    }
    const id = uuid();
    const operation = cleanOperation({ version: 1, boardId: this.id, id, actor: this.actorId, clock: { time: ++this.lamport, actor: this.actorId, id }, timestamp: isoNow(), ...descriptor }, this.id);
    this._apply(operation);
    this.transport?.send({ type: 'operation', operation, clientId: this.clientId });
    for (const fn of this.operationListeners) { try { fn(copy(operation), { source: 'local' }); } catch (error) { console.error('Operation subscriber:', error); } }
    return operation;
  }
  _commit(forward, inverse, label) {
    this._perform(forward);
    const entry = { forward: copy(forward), inverse: copy(inverse) };
    if (this.batchDepth) this.batchEntries.push(entry);
    else { this.history.push({ label, entries: [entry] }); if (this.history.length > 100) this.history.shift(); }
    this.redoHistory = [];
    this._notify('local', label);
  }
  addObject(input) {
    if (this.board.objects.length >= DOCUMENT_LIMITS.objects) throw new Error('Nombre maximal d’objets atteint.');
    const object = cleanObject({ ...input, id: input.id || uuid() });
    if (this.records.get(object.id)?.alive) throw new Error('Cet identifiant existe déjà.');
    validateBoard({ ...this.board, objects: [...this.board.objects, object] });
    const fields = copy(object); delete fields.id;
    this._commit({ kind: 'object.set', objectId: object.id, alive: true, fields, unset: [] }, { kind: 'object.delete', objectId: object.id }, 'Ajouter un objet');
    return object.id;
  }
  updateObject(id, patch) {
    validId(id);
    const record = this.records.get(id);
    if (!record?.alive) return false;
    if (Object.hasOwn(patch, 'id')) throw new Error('Identifiant d’objet immuable.');
    if (Object.hasOwn(patch, 'type')) throw new Error('Le type d’objet est immuable.');
    const fields = cleanFields(patch);
    const unset = Object.entries(patch).filter(([, value]) => value === undefined).map(([key]) => key);
    if (!Object.keys(fields).length && !unset.length) return false;
    const merged = { id, ...record.fields, ...fields };
    for (const key of unset) delete merged[key];
    cleanObject(merged);
    validateBoard({ ...this.board, objects: this.board.objects.map(object => object.id === id ? merged : object) });
    if (unset.includes('votes')) { unset.splice(unset.indexOf('votes'), 1); fields.votes = {}; }
    const before = {}; const unsetBefore = [];
    for (const key of [...Object.keys(fields), ...unset]) {
      if (Object.hasOwn(record.fields, key)) before[key] = copy(record.fields[key]);
      else unsetBefore.push(key);
    }
    const unsetVotes = []; const unsetVotesBefore = [];
    if (Object.hasOwn(fields, 'votes')) {
      const previous = record.fields.votes || {};
      const next = fields.votes;
      const changedVotes = {}; const beforeVotes = {};
      for (const actor of new Set([...Object.keys(previous), ...Object.keys(next)])) {
        if (previous[actor] === next[actor]) continue;
        if (Object.hasOwn(next, actor)) changedVotes[actor] = next[actor]; else unsetVotes.push(actor);
        if (Object.hasOwn(previous, actor)) beforeVotes[actor] = previous[actor]; else unsetVotesBefore.push(actor);
      }
      fields.votes = changedVotes; before.votes = beforeVotes;
      // Removing the entire votes map is represented by participant tombstones.
      const absent = unsetBefore.indexOf('votes'); if (absent >= 0) unsetBefore.splice(absent, 1);
    }
    this._commit({ kind: 'object.set', objectId: id, fields, unset, unsetVotes }, { kind: 'object.set', objectId: id, fields: before, unset: unsetBefore, unsetVotes: unsetVotesBefore }, 'Modifier un objet');
    return true;
  }
  removeObject(id) {
    validId(id);
    const record = this.records.get(id);
    if (!record?.alive) return false;
    this._commit({ kind: 'object.delete', objectId: id }, { kind: 'object.set', objectId: id, alive: true, fields: copy(record.fields), unset: [] }, 'Supprimer un objet');
    return true;
  }
  setTitle(title) { return this._setMetadata({ title }); }
  setDescription(description) { return this._setMetadata({ description }); }
  _setMetadata(fields) {
    const inverse = Object.fromEntries(Object.keys(fields).map(key => [key, this.metadata[key]]));
    this._commit({ kind: 'board.set', fields }, { kind: 'board.set', fields: inverse }, 'Modifier le tableau');
    return true;
  }
  batch(label, fn) {
    if (typeof fn !== 'function') throw new TypeError('Action attendue.');
    const outer = this.batchDepth === 0;
    if (outer) { this.batchEntries = []; this.batchLabel = String(label || 'Modifier le tableau'); }
    this.batchDepth++;
    try { return fn(); }
    finally {
      this.batchDepth--;
      if (outer) {
        if (this.batchEntries.length) { this.history.push({ label: this.batchLabel, entries: this.batchEntries }); if (this.history.length > 100) this.history.shift(); }
        this.batchEntries = [];
        if (this.dirty) { this.dirty = false; this._notify('local', this.batchLabel); }
      }
    }
  }
  undo() {
    const item = this.history.pop();
    if (!item) return false;
    this.batchDepth++;
    try { for (const entry of [...item.entries].reverse()) this._perform(entry.inverse); }
    finally { this.batchDepth--; }
    this.redoHistory.push(item); this._notify('undo', item.label); return true;
  }
  redo() {
    const item = this.redoHistory.pop();
    if (!item) return false;
    this.batchDepth++;
    try { for (const entry of item.entries) this._perform(entry.forward); }
    finally { this.batchDepth--; }
    this.history.push(item); this._notify('redo', item.label); return true;
  }
  /** Import into the current project through undoable operations. */
  replaceBoard(input) {
    const board = validateBoard(input);
    if (board.id !== this.id) throw new Error('Pour ouvrir un autre projet, créez un BoardStore avec son document.');
    this.batch('Importer le tableau', () => {
      for (const object of this.board.objects) this.removeObject(object.id);
      for (const object of board.objects) this.addObject(object);
      this._setMetadata({ title: board.title, description: board.description });
    });
    return this.board;
  }
  receiveOperation(value) {
    if (this.destroyed) return false;
    let operation;
    try { operation = cleanOperation(value, this.id); } catch { return false; }
    // Protect the local logical clock from a corrupt or hostile jump. A server
    // transport must authenticate actors and enforce equivalent room limits.
    if (operation.clock.time > this.lamport + 1000000) return false;
    if (this.seen.has(operation.id)) return false;
    // Validate the candidate before committing an untrusted incoming operation.
    const state = { records: copy([...this.records.entries()]), metadata: copy(this.metadata), metadataClocks: copy(this.metadataClocks), updatedAt: this.updatedAt, lamport: this.lamport, journalLength: this.journal.length };
    const changed = this._apply(operation);
    try { validateBoard(this.board); }
    catch {
      this.records = new Map(state.records); this.metadata = state.metadata; this.metadataClocks = state.metadataClocks; this.updatedAt = state.updatedAt; this.lamport = state.lamport; this.journal.length = state.journalLength; this.seen.delete(operation.id);
      return false;
    }
    for (const fn of this.operationListeners) { try { fn(copy(operation), { source: 'remote' }); } catch (error) { console.error('Operation subscriber:', error); } }
    if (changed) this._notify('remote', 'Synchronisation locale'); else this._persist();
    return changed;
  }
  _receiveMessage(message) {
    if (!message || message.clientId === this.clientId) return;
    if (message.type === 'operation') this.receiveOperation(message.operation);
    else if (message.type === 'hello' && message.boardId === this.id && message.version === 1) {
      for (const operation of this.journal) this.transport?.send({ type: 'operation', operation, clientId: this.clientId });
    }
  }
  destroy() {
    if (this.destroyed) return;
    this._persist(); this.unsubscribeTransport?.(); this.transport?.destroy?.();
    this.listeners.clear(); this.operationListeners.clear(); this.destroyed = true;
  }
}
