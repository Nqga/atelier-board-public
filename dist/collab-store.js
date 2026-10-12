import { Y, boardFromDoc, docFromBoard, objectToShared, replaceYText, encodeBase64, decodeBase64 } from './shared-model.js';
import { validateBoard } from './store.js';
import { IndexedDBCollaborationCache } from './collab-cache.js';

const LOCAL = Symbol('local-edit');
const REMOTE = Symbol('remote-edit');
const uuid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes); else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const clone = value => structuredClone(value);
const noopUpdate = () => new Uint8Array([0, 0]);
// State vectors do not cover deletions: include Yjs tombstones before declaring
// an old pending slot fully acknowledged by the authoritative server state.
function coveredByServer(doc, serverDoc) {
  const localVector = Y.decodeStateVector(Y.encodeStateVector(doc));
  const serverVector = Y.decodeStateVector(Y.encodeStateVector(serverDoc));
  for (const [client, clock] of localVector) if ((serverVector.get(client) || 0) < clock) return false;
  const localDeletes = Y.decodeUpdate(Y.encodeStateAsUpdate(doc)).ds.clients;
  const serverDeletes = Y.decodeUpdate(Y.encodeStateAsUpdate(serverDoc)).ds.clients;
  for (const [client, ranges] of localDeletes) {
    const accepted = serverDeletes.get(client) || [];
    for (const range of ranges) {
      let position = range.clock;
      const end = range.clock + range.len;
      for (const known of accepted) {
        if (known.clock > position) break;
        if (known.clock + known.len > position) position = known.clock + known.len;
        if (position >= end) break;
      }
      if (position < end) return false;
    }
  }
  return true;
}
const callListeners = (listeners, ...args) => { for (const fn of listeners) { try { fn(...args); } catch (error) { console.error('Collaboration subscriber:', error); } } };

/** Yjs document with server acknowledgements and per-guest offline recovery. */
export class CollaborativeBoardStore {
  static async open(meta, options = {}) {
    const store = new CollaborativeBoardStore(meta, options);
    await store._restore();
    store._observe();
    await store._persist();
    store._connect();
    return store;
  }
  constructor(meta, options = {}) {
    const board = validateBoard(meta.board);
    if (!options.user || typeof options.user.id !== 'string') throw new Error('Identité d’invité manquante.');
    this.id = board.id; this.user = clone(options.user); this.actorId = options.user.id;
    this.role = meta.role || 'viewer'; this.revision = meta.revision || 0; this.updatedAt = meta.updatedAt || board.updatedAt;
    this.doc = meta.state ? new Y.Doc() : docFromBoard(board);
    if (meta.state) Y.applyUpdate(this.doc, decodeBase64(meta.state), REMOTE);
    boardFromDoc(this.doc, this.id, { updatedAt: this.updatedAt });
    this.cache = options.cache === false ? null : (options.cache || new IndexedDBCollaborationCache());
    this.cacheKey = `${this.actorId}:${this.id}`; this.recoveryKey = `${this.cacheKey}:recovery`;
    this.pendingPrefix = `${this.cacheKey}:pending:`; this.recoveryPrefix = `${this.cacheKey}:recovery:`; this.pendingSlotKey = `${this.pendingPrefix}${uuid()}`;
    this.WebSocket = options.WebSocket || globalThis.WebSocket;
    const location = options.location || globalThis.location;
    this.url = options.url || (location ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/boards/${encodeURIComponent(this.id)}/live` : null);
    this.batchDelay = options.batchDelay ?? 40; this.ackTimeout = options.ackTimeout ?? 12000;
    this.reconnectMin = options.reconnectMin ?? 600; this.reconnectMax = options.reconnectMax ?? 15000;
    this.listeners = new Set(); this.statusListeners = new Set(); this.presenceListeners = new Set(); this.beforeRemoteListeners = new Set();
    this.pending = new Map(); this.queue = []; this.hasPending = false; this.lastSaved = false; this.cacheSaved = false;
    this.status = 'connecting'; this.error = null; this.users = []; this.presence = { cursor: null, selection: [], editing: null };
    this.destroyed = false; this.ready = false; this.rejected = false; this.restoredPending = false; this.reconnectAttempts = 0;
    this.socket = null; this._cacheChain = Promise.resolve(); this._cacheGeneration = 0; this._label = ''; this._source = 'local'; this._batchDepth = 0;
    this._remotePauseDepth = 0; this._remoteQueue = [];
    this.undoManager = new Y.UndoManager([this.doc.getMap('meta'), this.doc.getMap('objects')], { trackedOrigins: new Set([LOCAL]), captureTimeout: 700 });
    this._onlineHandler = () => { if (!this.socket && !this.destroyed && !this.rejected) { clearTimeout(this._reconnectTimer); this._connect(); } };
    globalThis.addEventListener?.('online', this._onlineHandler);
  }
  get board() { return boardFromDoc(this.doc, this.id, { updatedAt: this.updatedAt }); }
  get canEdit() { return !this.destroyed && !this.rejected && ['owner', 'editor'].includes(this.role); }
  get canUndo() { return this.canEdit && this.undoManager.undoStack.length > 0; }
  get canRedo() { return this.canEdit && this.undoManager.redoStack.length > 0; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onBeforeRemote(fn) { this.beforeRemoteListeners.add(fn); return () => this.beforeRemoteListeners.delete(fn); }
  onStatus(fn) { this.statusListeners.add(fn); fn(this._statusInfo()); return () => this.statusListeners.delete(fn); }
  onPresence(fn) { this.presenceListeners.add(fn); fn(clone(this.users)); return () => this.presenceListeners.delete(fn); }
  // IME composition must finish against its original text before remote deltas merge.
  pauseRemote() { this._remotePauseDepth++; }
  resumeRemote() {
    if (this._remotePauseDepth > 0) this._remotePauseDepth--;
    if (this._remotePauseDepth || this.destroyed) return;
    const messages = this._remoteQueue; this._remoteQueue = [];
    for (const message of messages) {
      try { this._receive(message); } catch (error) { this._reject(error.message); break; }
    }
    if (this.ready && !this.rejected) this._setStatus(this.role === 'viewer' ? 'readonly' : this.lastSaved ? 'synced' : 'syncing');
  }
  _statusInfo() { return { status: this.status, hasPending: this.hasPending, lastSaved: this.lastSaved, cacheSaved: this.cacheSaved, role: this.role, canEdit: this.canEdit, revision: this.revision, error: this.error }; }
  _emitStatus() { callListeners(this.statusListeners, this._statusInfo()); }
  _setStatus(status, error = this.error) { this.status = status; this.error = error; this._emitStatus(); }
  _assertEditable() { if (!this.canEdit) throw new Error(this.rejected ? 'Modifications suspendues : votre copie locale reste récupérable.' : 'Ce projet est en lecture seule.'); }
  async _restore() {
    if (!this.cache) return;
    let cached, slots = [], recoverySlots = [];
    try {
      this.recoveryDraft = await this.cache.get(this.recoveryKey) || undefined;
      [cached, slots, recoverySlots] = await Promise.all([this.cache.get(this.cacheKey), this.cache.list?.(this.pendingPrefix) || [], this.cache.list?.(this.recoveryPrefix) || []]);
    } catch { return; }
    const entries = [...(cached?.state ? [{ key: this.cacheKey, value: cached }] : []), ...slots.filter(entry => entry.value?.state), ...recoverySlots.filter(entry => entry.value?.state)];
    if (!entries.length) return;
    const authoritative = new Y.Doc(), candidate = new Y.Doc();
    const obsolete = [], quarantine = [];
    try {
      const serverState = Y.encodeStateAsUpdate(this.doc);
      Y.applyUpdate(authoritative, serverState); Y.applyUpdate(candidate, serverState);
      const recover = [];
      for (const entry of entries) {
        const update = decodeBase64(entry.value.state);
        const slotDoc = new Y.Doc();
        let covered;
        try { Y.applyUpdate(slotDoc, update); boardFromDoc(slotDoc, this.id); covered = coveredByServer(slotDoc, authoritative); }
        finally { slotDoc.destroy(); }
        if (covered && entry.key.startsWith(this.pendingPrefix)) obsolete.push(entry);
        const quarantined = entry.key.startsWith(this.recoveryPrefix);
        if (!covered && (this.role === 'viewer' || entry.value.rejected || quarantined)) {
          recover.push(entry.value);
          if (entry.key.startsWith(this.pendingPrefix)) quarantine.push(entry);
        } else if (!quarantined && this.role !== 'viewer' && !entry.value.rejected) Y.applyUpdate(candidate, update);
      }
      if (recover.length) {
        const recoveryDoc = new Y.Doc();
        try {
          Y.applyUpdate(recoveryDoc, serverState);
          for (const value of recover) Y.applyUpdate(recoveryDoc, decodeBase64(value.state));
          this.recoveryDraft = { ...recover.at(-1), state: encodeBase64(Y.encodeStateAsUpdate(recoveryDoc)), board: boardFromDoc(recoveryDoc, this.id), hasPending: true };
        } finally { recoveryDoc.destroy(); }
      }
      // Existing refused drafts remain recoverable; other tab slots are retained.
      if (cached?.hasPending && cached.rejected && this.role !== 'viewer' && recover.length) {
        this.rejected = true; this.hasPending = true; this._setStatus('error', cached.error || 'Une copie locale refusée est disponible à récupérer.');
      }
      boardFromDoc(candidate, this.id, { updatedAt: this.updatedAt });
      this.hasPending = this.restoredPending = this.rejected || (this.role !== 'viewer' && !coveredByServer(candidate, authoritative));
      Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(candidate), REMOTE);
      if (this.hasPending) for (const { value } of entries) if (value.updatedAt > this.updatedAt) this.updatedAt = value.updatedAt;
      // Quarantined drafts stay recoverable and are never silently re-uploaded.
      for (const entry of quarantine) {
        const key = this.recoveryPrefix + entry.key.slice(this.pendingPrefix.length);
        if ((await this.cache.set(key, entry.value)) !== false) await this.cache.deleteIfUnchanged?.(entry.key, entry.value);
      }
      // Only the server can prove a previous tab's pending slot no longer matters.
      for (const entry of obsolete) await this.cache.deleteIfUnchanged?.(entry.key, entry.value);
    } catch { this.recoveryDraft ||= cached || slots[0]?.value; }
    finally { candidate.destroy(); authoritative.destroy(); }
  }
  _observe() {
    this._updateHandler = (update, origin) => {
      if (this.destroyed) return;
      const local = origin === LOCAL || origin === this.undoManager;
      if (local) {
        this.queue.push(update); this.hasPending = true; this.lastSaved = false; this.updatedAt = new Date().toISOString();
        this._setStatus(this.ready ? 'syncing' : 'offline', null);
        if (this.ready && !this._flushTimer) this._flushTimer = this._timer(() => { this._flushTimer = null; this._flush(); }, this.batchDelay);
      }
      this._persist();
      callListeners(this.listeners, this.board, { source: local ? this._source : 'remote', label: local ? this._label : 'Synchronisation' });
    };
    this.doc.on('update', this._updateHandler);
  }
  _persist() {
    if (!this.cache) { this.cacheSaved = false; return Promise.resolve(false); }
    // Capture now, then serialize writes so an older snapshot never wins a race.
    const snapshot = this.recoveryDraft && this.rejected ? this.recoveryDraft : {
      version: 2, state: encodeBase64(Y.encodeStateAsUpdate(this.doc)), hasPending: this.hasPending,
      rejected: this.rejected, error: this.error, revision: this.revision, updatedAt: this.updatedAt,
    };
    const generation = ++this._cacheGeneration;
    const recovery = this.recoveryDraft ? clone(this.recoveryDraft) : null;
    const pendingSnapshot = this.hasPending ? snapshot : null;
    this.cacheSaved = false; this._emitStatus();
    this._cacheChain = this._cacheChain.catch(() => false).then(async () => {
      let saved = false;
      try {
        // Keep recovery separate: later promotion and ACKs cannot overwrite it.
        if (recovery && (await this.cache.set(this.recoveryKey, recovery)) === false) throw new Error('Cache de récupération indisponible.');
        // Each tab owns its pending slot; another tab's latest snapshot cannot
        // erase offline edits. ACKs only remove the current tab's own slot.
        if (pendingSnapshot && (await this.cache.set(this.pendingSlotKey, pendingSnapshot)) === false) throw new Error('Cache du brouillon indisponible.');
        if (!pendingSnapshot) await this.cache.delete?.(this.pendingSlotKey);
        saved = (await this.cache.set(this.cacheKey, snapshot)) !== false;
      } catch { saved = false; }
      if (generation === this._cacheGeneration) {
        this.cacheSaved = saved;
        if (!this.destroyed) this._emitStatus();
      }
      return saved;
    });
    return this._cacheChain;
  }
  _timer(fn, delay) { const timer = setTimeout(fn, delay); timer.unref?.(); return timer; }
  _connect() {
    if (this.destroyed || this.rejected || this.socket) return;
    if (!this.WebSocket || !this.url) { this._setStatus(this.role === 'viewer' ? 'readonly' : 'offline'); return; }
    this.ready = false; this.lastSaved = false; this._setStatus('connecting', null);
    let socket;
    try { socket = new this.WebSocket(this.url); } catch (error) { this._setStatus('offline', error.message); this._reconnect(); return; }
    this.socket = socket;
    const listen = (name, fn) => socket.addEventListener ? socket.addEventListener(name, fn) : socket.on(name, (...args) => fn(name === 'message' ? { data: args[0].toString() } : name === 'close' ? { code: args[0], reason: args[1]?.toString() } : {}));
    listen('open', () => { if (this.socket === socket) this._setStatus('syncing', null); });
    listen('message', event => { if (this.socket !== socket || this.destroyed) return; try { this._receive(JSON.parse(event.data)); } catch (error) { this._reject(error.message); } });
    listen('close', event => {
      if (this.socket !== socket) return;
      this.socket = null; this.ready = false; this.lastSaved = false; clearTimeout(this._ackTimer); this._ackTimer = null;
      if (this.destroyed) return;
      if (event.code === 1008) { this._reject(event.reason || 'Votre accès au projet a été retiré.', 'denied'); return; }
      if (!this.rejected) { this._setStatus('offline'); this._reconnect(); }
    });
    listen('error', () => { if (this.socket === socket && !this.ready) this._setStatus('offline', 'Connexion au serveur interrompue.'); });
    clearTimeout(this._handshakeTimer);
    this._handshakeTimer = this._timer(() => { if (!this.ready && this.socket === socket) this._disconnectForRetry('La connexion au serveur tarde ; reconnexion en cours.'); }, this.ackTimeout);
  }
  _disconnectForRetry(message) {
    const socket = this.socket; this.socket = null; this.ready = false; this.lastSaved = false;
    clearTimeout(this._ackTimer); this._ackTimer = null; clearTimeout(this._handshakeTimer); this._handshakeTimer = null;
    try { socket?.close(); } catch { /* Already disconnected. */ }
    if (!this.destroyed && !this.rejected) { this._setStatus('offline', message); this._reconnect(); }
  }
  _reconnect() {
    if (this.destroyed || this.rejected || this._reconnectTimer) return;
    const delay = Math.min(this.reconnectMax, this.reconnectMin * 2 ** Math.min(this.reconnectAttempts++, 8)) * (0.8 + Math.random() * 0.4);
    this._reconnectTimer = this._timer(() => { this._reconnectTimer = null; this._connect(); }, delay);
  }
  _send(message) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    try { this.socket.send(JSON.stringify(message)); return true; } catch { this.socket.close(); return false; }
  }
  _applyRemote(state) {
    const update = typeof state === 'string' ? decodeBase64(state) : state;
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.doc));
      Y.applyUpdate(candidate, update);
      boardFromDoc(candidate, this.id, { updatedAt: this.updatedAt });
    } finally { candidate.destroy(); }
    callListeners(this.beforeRemoteListeners);
    Y.applyUpdate(this.doc, update, REMOTE);
  }
  _receive(message) {
    if (!message || typeof message.type !== 'string') throw new Error('Message de synchronisation invalide.');
    if (this._remotePauseDepth && ['sync', 'update'].includes(message.type)) {
      this._remoteQueue.push(message);
      if (message.type === 'sync') {
        if (!['owner', 'editor', 'viewer'].includes(message.role)) throw new Error('Autorisation de projet invalide.');
        clearTimeout(this._handshakeTimer); this._handshakeTimer = null;
        // A reconnect handshake may change access while the IME is still active.
        if (message.role !== this.role) this._receive({ type: 'role', role: message.role });
      }
      if (!this.rejected) this._setStatus(this.role === 'viewer' ? 'readonly' : 'syncing');
      return;
    }
    if (message.type === 'sync') {
      if (!['owner', 'editor', 'viewer'].includes(message.role)) throw new Error('Autorisation de projet invalide.');
      this.role = message.role; this.revision = message.revision || 0; this.updatedAt = message.updatedAt || this.updatedAt;
      this._applyRemote(message.state);
      this.users = Array.isArray(message.users) ? clone(message.users) : [];
      callListeners(this.presenceListeners, clone(this.users));
      clearTimeout(this._handshakeTimer); this._handshakeTimer = null; this.ready = true;
      this.pending.clear(); this.queue = []; clearTimeout(this._flushTimer); this._flushTimer = null; clearTimeout(this._ackTimer); this._ackTimer = null;
      if (this.role === 'viewer') {
        if (this.hasPending) { this._reject('Votre accès est désormais en lecture seule ; votre copie locale est conservée.', 'readonly'); return; }
        this.lastSaved = false; this._setStatus('readonly', null); this._persist();
      } else {
        const missing = this.hasPending ? Y.encodeStateAsUpdate(this.doc, decodeBase64(message.vector)) : noopUpdate();
        this.restoredPending = false; this._sendUpdate(missing); this._setStatus('syncing', null);
      }
      this.updatePresence(this.presence);
    } else if (message.type === 'update') {
      this.revision = message.revision ?? this.revision; this.updatedAt = message.updatedAt || this.updatedAt;
      this._applyRemote(message.update); this._persist();
    } else if (message.type === 'ack') {
      if (!this.pending.delete(message.id)) return;
      if (this.rejected) { this._persist(); this._emitStatus(); return; }
      this.revision = Math.max(this.revision, message.revision || 0); this.updatedAt = message.updatedAt || this.updatedAt;
      this.hasPending = this.pending.size > 0 || this.queue.length > 0 || this.restoredPending;
      this.lastSaved = !this.hasPending && !this.rejected;
      // A transport handshake alone does not mean persistence has recovered.
      this.reconnectAttempts = 0;
      this._setStatus(this.role === 'viewer' ? 'readonly' : this.lastSaved && !this._remoteQueue.length ? 'synced' : 'syncing', null);
      this._scheduleAckTimeout(); this._persist();
    } else if (message.type === 'presence') {
      this.users = Array.isArray(message.users) ? clone(message.users) : []; callListeners(this.presenceListeners, clone(this.users));
    } else if (message.type === 'role') {
      if (!['owner', 'editor', 'viewer'].includes(message.role)) throw new Error('Autorisation de projet invalide.');
      this.role = message.role;
      if (this.role === 'viewer') {
        if (this.hasPending) this._reject('Votre accès est désormais en lecture seule ; votre copie locale est conservée.', 'readonly');
        else this._setStatus('readonly');
      } else if (this.ready && !this.rejected) {
        this._setStatus('syncing', null);
        this._sendUpdate(noopUpdate());
      } else this._emitStatus();
    } else if (message.type === 'error') {
      if (['SAVE_FAILED', 'RATE_LIMIT', 'SERVER_UNAVAILABLE', 'TEMPORARY_FAILURE'].includes(message.code)) {
        this.hasPending = this.hasPending || this.queue.length > 0 || this.pending.size > 0;
        this._persist();
        this._disconnectForRetry(message.message || 'Le serveur est temporairement indisponible ; votre travail reste conservé.');
      } else if (message.code === 'READ_ONLY') {
        this.role = 'viewer';
        this._reject(message.message || 'Votre accès est désormais en lecture seule.', 'readonly');
      } else this._reject(message.message || 'Le serveur a refusé les modifications.', /forbidden|revoked|unauthorized|denied|session_required/i.test(message.code || '') ? 'denied' : 'error');
    }
  }
  _sendUpdate(update) {
    const id = uuid();
    this.pending.set(id, { update, sentAt: Date.now() });
    this.lastSaved = false;
    if (!this._send({ type: 'update', id, update: encodeBase64(update) })) this.socket?.close();
    this._scheduleAckTimeout();
  }
  _flush() {
    if (!this.ready || !this.canEdit || !this.queue.length) return;
    const update = Y.mergeUpdates(this.queue); this.queue = [];
    this._sendUpdate(update); this._persist();
  }
  _scheduleAckTimeout() {
    clearTimeout(this._ackTimer); this._ackTimer = null;
    if (!this.pending.size || !this.ready) return;
    const oldest = Math.min(...[...this.pending.values()].map(value => value.sentAt));
    this._ackTimer = this._timer(() => { this._ackTimer = null; if (this.pending.size && this.socket) { this._disconnectForRetry('La confirmation du serveur tarde ; reconnexion en cours.'); } }, Math.max(1, this.ackTimeout - (Date.now() - oldest)));
  }
  _reject(message, status = 'error') {
    this.rejected = true; this.ready = false; this.lastSaved = false;
    if (this.hasPending || this.queue.length || this.pending.size) {
      this.hasPending = true;
      this.recoveryDraft = { version: 2, state: encodeBase64(Y.encodeStateAsUpdate(this.doc)), board: this.board, hasPending: true, rejected: true, error: message, revision: this.revision, updatedAt: this.updatedAt };
    }
    clearTimeout(this._flushTimer); clearTimeout(this._ackTimer); clearTimeout(this._reconnectTimer);
    this._setStatus(status, message); this._persist();
  }
  updatePresence(patch = {}) {
    this.presence = { ...this.presence, ...clone(patch) };
    if (this.ready && !this.rejected) this._send({ type: 'presence', ...this.presence });
  }
  _mutate(label, fn, text = false) {
    this._assertEditable();
    const outer = this._batchDepth === 0;
    if (outer) { this._label = label; this._source = 'local'; if (!text) this.undoManager.stopCapturing(); }
    let result;
    this.doc.transact(() => { result = fn(); }, LOCAL);
    if (outer && !text) this.undoManager.stopCapturing();
    return result;
  }
  getText(id) { return this.doc.getMap('objects').get(id)?.get('text') || null; }
  replaceText(id, next) {
    const object = this.board.objects.find(object => object.id === id);
    if (!object) return false;
    validateBoard({ ...this.board, objects: this.board.objects.map(item => item.id === id ? { ...item, text: next } : item) });
    return this._mutate('Modifier le texte', () => replaceYText(this.getText(id), next), true);
  }
  endTextEdit() { this.undoManager.stopCapturing(); }
  addObject(input) {
    this._assertEditable();
    const id = input.id || uuid();
    if (this.doc.getMap('objects').has(id)) throw new Error('Cet identifiant existe déjà.');
    const candidate = validateBoard({ ...this.board, objects: [...this.board.objects, { ...input, id }] });
    const object = candidate.objects.find(item => item.id === id);
    return this._mutate('Ajouter un objet', () => { this.doc.getMap('objects').set(id, objectToShared(object)); return id; });
  }
  updateObject(id, patch) {
    this._assertEditable();
    if (!patch || typeof patch !== 'object') throw new Error('Modification invalide.');
    if ('id' in patch || 'type' in patch) throw new Error('Identifiant et type d’objet immuables.');
    const previous = this.board.objects.find(item => item.id === id);
    if (!previous) return false;
    const merged = { ...previous, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete merged[key];
    if ('votes' in patch) {
      merged.votes = { ...previous.votes };
      const votes = patch.votes || {};
      for (const [actor, count] of Object.entries(votes)) {
        if (count !== 0 && count !== 1) throw new Error('Un participant dispose d’un vote par idée.');
        if (actor !== this.actorId && count !== previous.votes?.[actor]) throw new Error('Vous pouvez modifier uniquement votre propre vote.');
      }
      if (Object.hasOwn(votes, this.actorId)) merged.votes[this.actorId] = votes[this.actorId];
      else delete merged.votes[this.actorId];
    }
    const candidate = validateBoard({ ...this.board, objects: this.board.objects.map(item => item.id === id ? merged : item) });
    const clean = candidate.objects.find(item => item.id === id);
    return this._mutate('Modifier un objet', () => {
      const object = this.doc.getMap('objects').get(id);
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'text') replaceYText(object.get('text'), clean.text || '');
        else if (key === 'votes') {
          const votes = object.get('votes');
          if (Object.hasOwn(clean.votes, this.actorId)) votes.set(this.actorId, clean.votes[this.actorId]); else votes.delete(this.actorId);
        } else if (value === undefined) object.delete(key);
        else object.set(key, clone(clean[key]));
      }
      return true;
    });
  }
  removeObject(id) { this._assertEditable(); if (!this.doc.getMap('objects').has(id)) return false; return this._mutate('Supprimer un objet', () => { this.doc.getMap('objects').delete(id); return true; }); }
  setTitle(title) { return this._setMetadata({ title }); }
  setDescription(description) { return this._setMetadata({ description }); }
  _setMetadata(fields) {
    validateBoard({ ...this.board, ...fields });
    return this._mutate('Modifier le tableau', () => { for (const [key, value] of Object.entries(fields)) this.doc.getMap('meta').set(key, value); return true; });
  }
  batch(label, fn) {
    if (typeof fn !== 'function') throw new TypeError('Action attendue.');
    this._assertEditable();
    const outer = this._batchDepth === 0;
    if (outer) { this._label = String(label || 'Modifier le tableau'); this._source = 'local'; this.undoManager.stopCapturing(); }
    this._batchDepth++;
    try { let result; this.doc.transact(() => { result = fn(); }, LOCAL); return result; }
    finally { this._batchDepth--; if (outer) this.undoManager.stopCapturing(); }
  }
  undo() { this._assertEditable(); if (!this.canUndo) return false; this._source = 'undo'; this._label = 'Annuler'; this.undoManager.undo(); this.undoManager.stopCapturing(); return true; }
  redo() { this._assertEditable(); if (!this.canRedo) return false; this._source = 'redo'; this._label = 'Rétablir'; this.undoManager.redo(); this.undoManager.stopCapturing(); return true; }
  replaceBoard(input) {
    const board = validateBoard(input);
    if (board.id !== this.id) throw new Error('Identifiant du projet immuable.');
    this.batch('Importer le tableau', () => {
      for (const id of this.doc.getMap('objects').keys()) this.removeObject(id);
      for (const object of board.objects) this.addObject(object);
      this._setMetadata({ title: board.title, description: board.description });
    });
    return this.board;
  }
  async save() { this._flush(); await this._persist(); return this.lastSaved; }
  destroy() {
    if (this.destroyed) return;
    this._flush(); this._persist(); this.destroyed = true;
    for (const timer of [this._flushTimer, this._ackTimer, this._handshakeTimer, this._reconnectTimer]) clearTimeout(timer);
    globalThis.removeEventListener?.('online', this._onlineHandler);
    this.doc.off('update', this._updateHandler); this.socket?.close(); this.socket = null;
    this.undoManager.destroy(); this.listeners.clear(); this.statusListeners.clear(); this.presenceListeners.clear(); this.beforeRemoteListeners.clear();
    this.doc.destroy();
  }
}
