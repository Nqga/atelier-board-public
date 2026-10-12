import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename, stat } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Y, docFromBoard, boardFromDoc } from '../dist/shared-model.js';
import { validateBoard } from '../dist/store.js';
import { openDatabase, transaction, MAX_RETAINED_UPDATES } from './database.mjs';
import { normalizeQuotas, createQuotaManager } from './quotas.mjs';
import { ApiError, fail, UUID, TOKEN, COOKIE, ROLES, randomToken, hash, requireId, nameOf, cookieToken, decodeUpdate, readBody, readJSON, imageMime, RateLimiter } from './security.mjs';

const DAY = 86400000;
const SESSION_DAYS = 365;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const STATIC_MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const COLORS = ['#CB3266', '#4573C5', '#248772', '#9863BD', '#AE7422', '#368B9A'];
const isEditor = role => role === 'editor' || role === 'owner';
const objectId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const base64 = value => Buffer.from(value).toString('base64');

/** One durable SQLite writer and one authoritative Yjs document per active room. */
export async function createAtelierServer(options = {}) {
  const quotaLimits = normalizeQuotas(options.quotas);
  const dataDir = resolve(options.dataDir || './data');
  const staticDir = resolve(import.meta.dirname, '../dist');
  const host = options.host || '127.0.0.1';
  const port = options.port ?? 3000;
  const now = options.now || (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  let publicOrigin = null;
  if (options.publicUrl) {
    const url = new URL(options.publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PUBLIC_URL doit être une origine HTTP(S), sans chemin.');
    publicOrigin = url.origin;
  }
  await mkdir(join(dataDir, 'assets'), { recursive: true, mode: 0o700 });
  const db = openDatabase(dataDir);
  const quotas = createQuotaManager(db, dataDir, quotaLimits);
  try { await quotas.reconcile(); }
  catch (error) { db.close(); throw error; }
  const limiter = new RateLimiter(now);
  const rooms = new Map();
  let closed = false;
  let closePromise = null;
  let started = false;

  function requestOrigin(req) {
    if (publicOrigin) return publicOrigin;
    const forwardedProto = options.trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
    const protocol = req.socket.encrypted || forwardedProto === 'https' ? 'https' : 'http';
    const forwardedHost = options.trustProxy ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
    const authority = forwardedHost || req.headers.host;
    if (!authority || /[\s\\/@]/.test(authority)) fail(400, 'INVALID_HOST', 'Hôte invalide.');
    try { return new URL(`${protocol}://${authority}`).origin; }
    catch { fail(400, 'INVALID_HOST', 'Hôte invalide.'); }
  }
  function checkOrigin(req, required = false) {
    const origin = req.headers.origin;
    if (!origin) {
      if (required) fail(403, 'ORIGIN_FORBIDDEN', 'L’origine de la connexion est requise.');
      if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'ORIGIN_FORBIDDEN', 'Cette origine n’est pas autorisée.');
      return;
    }
    if (origin !== requestOrigin(req)) fail(403, 'ORIGIN_FORBIDDEN', 'Cette origine n’est pas autorisée.');
  }
  function secureCookie(req) { return requestOrigin(req).startsWith('https:'); }
  function sessionCookie(req, token, clear = false) {
    return `${COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_DAYS * 86400}${secureCookie(req) ? '; Secure' : ''}`;
  }
  function authenticate(req, required = true) {
    const token = cookieToken(req);
    if (!token) {
      if (required) fail(401, 'SESSION_REQUIRED', 'Choisissez un pseudonyme pour rejoindre ce projet.');
      return null;
    }
    const tokenHash = hash(token);
    const row = db.prepare('SELECT u.id,u.name,u.color,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(tokenHash);
    if (!row || row.expires_at <= now()) {
      if (required) fail(401, 'SESSION_REQUIRED', 'Votre session a expiré. Choisissez à nouveau un pseudonyme.');
      return null;
    }
    return { user: { id: row.id, name: row.name, color: row.color }, tokenHash, expiresAt: row.expires_at };
  }
  function membership(boardId, userId, role = null) {
    requireId(boardId);
    const row = db.prepare('SELECT role FROM members WHERE board_id=? AND user_id=?').get(boardId, userId);
    if (!row) fail(404, 'BOARD_NOT_FOUND', 'Projet introuvable ou accès retiré.');
    if (role === 'owner' && row.role !== 'owner') fail(403, 'OWNER_REQUIRED', 'Seul un propriétaire peut gérer ce projet.');
    if (role === 'editor' && !isEditor(row.role)) fail(403, 'READ_ONLY', 'Ce projet est en lecture seule pour vous.');
    return row.role;
  }
  function sessionPayload(session) { return { user: session?.user || null, collaboration: true, version: '2.0.0' }; }
  function json(res, status, payload, extraHeaders = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
    res.end(JSON.stringify(payload));
  }
  function send(socket, payload) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_STATE_BYTES * 2) { socket.close(1013, 'Connexion trop lente.'); return; }
    socket.send(JSON.stringify(payload));
  }
  function broadcast(room, payload, excluded = null) {
    for (const socket of room.sockets) if (socket !== excluded) send(socket, payload);
  }
  function roomUsers(room) {
    return [...room.sockets].filter(socket => socket.readyState === WebSocket.OPEN).map(socket => ({
      connectionId: socket.connectionId, userId: socket.user.id, name: socket.user.name,
      color: socket.user.color, cursor: socket.presence.cursor, selection: socket.presence.selection,
      editing: socket.presence.editing,
    }));
  }
  function presence(room) { broadcast(room, { type: 'presence', users: roomUsers(room) }); }
  function cacheRoom(room) {
    // HTTP-only project previews must not retain an unlimited number of documents.
    if (rooms.size >= 100) {
      for (const [id, idle] of rooms) {
        if (!idle.sockets.size) { idle.doc.destroy(); rooms.delete(id); break; }
      }
    }
    rooms.set(room.id, room);
  }
  function getRoom(boardId) {
    let room = rooms.get(boardId);
    if (room) return room;
    const row = db.prepare('SELECT * FROM boards WHERE id=?').get(boardId);
    if (!row) fail(404, 'BOARD_NOT_FOUND', 'Projet introuvable.');
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, row.state);
      const board = boardFromDoc(doc, boardId, { updatedAt: row.updated_at });
      room = { id: boardId, doc, board, state: Buffer.from(row.state), revision: row.revision, updatedAt: row.updated_at, sockets: new Set() };
      cacheRoom(room);
      return room;
    } catch (error) { doc.destroy(); throw error; }
  }
  function boardPayload(boardId, role) {
    const room = getRoom(boardId);
    return { board: room.board, state: base64(room.state), role, revision: room.revision, updatedAt: room.updatedAt };
  }
  function boardAssets(board) {
    for (const object of board.objects) {
      if (typeof object.src !== 'string') continue;
      let source = object.src;
      if (!source.startsWith('/')) {
        try {
          const url = new URL(source);
          if (!url.pathname.startsWith('/api/boards/')) continue;
          source = url.pathname;
        } catch { continue; }
      }
      const match = /^\/api\/boards\/([0-9a-f-]{36})\/assets\/([0-9a-f-]{36})$/i.exec(source);
      if (!match || match[1] !== board.id || !UUID.test(match[2]) || !db.prepare('SELECT 1 FROM assets WHERE id=? AND board_id=?').get(match[2], board.id)) fail(400, 'INVALID_ASSET', 'Cette image n’appartient pas à ce projet.');
    }
  }
  function changeMemberSockets(boardId, userId, newRole) {
    const room = rooms.get(boardId);
    if (!room) return;
    for (const socket of room.sockets) {
      if (socket.user.id !== userId) continue;
      if (!newRole) socket.close(1008, 'Votre accès à ce projet a été retiré.');
      else { socket.role = newRole; send(socket, { type: 'role', role: newRole }); }
    }
  }
  function ensureOwnerRemains(boardId, userId, nextRole) {
    const current = db.prepare('SELECT role FROM members WHERE board_id=? AND user_id=?').get(boardId, userId);
    if (!current) fail(404, 'MEMBER_NOT_FOUND', 'Participant introuvable.');
    if (current.role === 'owner' && nextRole !== 'owner' && db.prepare("SELECT count(*) AS count FROM members WHERE board_id=? AND role='owner'").get(boardId).count < 2) fail(409, 'LAST_OWNER', 'Le projet doit conserver au moins un propriétaire.');
    return current;
  }
  function invitationMeta(row) {
    return { id: row.id, role: row.role, createdAt: row.created_at, expiresAt: new Date(row.expires_at).toISOString(), revokedAt: row.revoked_at, expired: row.expires_at <= now() };
  }
  function requestIP(req) {
    return options.trustProxy ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim().slice(0, 100) : req.socket.remoteAddress;
  }

  async function route(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (!['GET', 'HEAD'].includes(req.method)) checkOrigin(req);
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { fail(400, 'INVALID_PATH', 'Chemin invalide.'); }
    const parts = pathname.split('/').filter(Boolean);
    const ip = requestIP(req);
    if (parts[0] !== 'api') return serveStatic(pathname, req, res);
    if (!limiter.allow(`http:${ip}`, 600)) fail(429, 'RATE_LIMIT', 'Trop de requêtes. Réessayez dans un instant.');
    if (parts.length === 2 && parts[1] === 'session') {
      if (req.method === 'GET') return json(res, 200, sessionPayload(authenticate(req, false)));
      if (req.method === 'POST') {
        if (!limiter.allow(`session:${ip}`, 30)) fail(429, 'RATE_LIMIT', 'Trop de nouvelles sessions. Réessayez dans un instant.');
        const body = await readJSON(req, 4096);
        const existing = authenticate(req, false);
        if (existing) return json(res, 200, sessionPayload(existing));
        const name = nameOf(body.name);
        const token = randomToken();
        const user = { id: randomUUID(), name, color: COLORS[Math.floor(Math.random() * COLORS.length)] };
        transaction(db, () => {
          db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(user.id, user.name, user.color, iso());
          db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), user.id, now() + SESSION_DAYS * DAY);
        });
        return json(res, 201, sessionPayload({ user }), { 'Set-Cookie': sessionCookie(req, token) });
      }
      if (req.method === 'PATCH') {
        const body = await readJSON(req, 4096);
        const session = authenticate(req);
        const name = nameOf(body.name);
        db.prepare('UPDATE users SET name=? WHERE id=?').run(name, session.user.id);
        session.user.name = name;
        for (const room of rooms.values()) {
          let changed = false;
          for (const socket of room.sockets) if (socket.user.id === session.user.id) { socket.user.name = name; changed = true; }
          if (changed) presence(room);
        }
        return json(res, 200, sessionPayload(session));
      }
      if (req.method === 'DELETE') {
        const token = cookieToken(req);
        if (token) {
          const tokenHash = hash(token);
          db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash);
          for (const room of rooms.values()) for (const socket of room.sockets) if (socket.tokenHash === tokenHash) socket.close(1008, 'Session fermée.');
        }
        return json(res, 200, sessionPayload(null), { 'Set-Cookie': sessionCookie(req, '', true) });
      }
      fail(405, 'METHOD_NOT_ALLOWED', 'Méthode non prise en charge.');
    }
    if (parts[1] === 'invitations' && parts[2] === 'join' && parts.length === 3 && req.method === 'POST') {
      if (!limiter.allow(`join:${ip}`, 60)) fail(429, 'RATE_LIMIT', 'Trop de tentatives d’invitation.');
      const body = await readJSON(req, 4096);
      const session = authenticate(req);
      if (typeof body.token !== 'string' || !TOKEN.test(body.token)) fail(404, 'INVITATION_INVALID', 'Ce lien d’invitation est invalide, expiré ou révoqué.');
      const invite = db.prepare('SELECT * FROM invitations WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').get(hash(body.token), now());
      if (!invite) fail(404, 'INVITATION_INVALID', 'Ce lien d’invitation est invalide, expiré ou révoqué.');
      const existing = db.prepare('SELECT role FROM members WHERE board_id=? AND user_id=?').get(invite.board_id, session.user.id);
      const role = existing && ROLES.indexOf(existing.role) > ROLES.indexOf(invite.role) ? existing.role : invite.role;
      db.prepare('INSERT INTO members VALUES(?,?,?,?) ON CONFLICT(board_id,user_id) DO UPDATE SET role=excluded.role').run(invite.board_id, session.user.id, role, iso());
      changeMemberSockets(invite.board_id, session.user.id, role);
      return json(res, 200, boardPayload(invite.board_id, role));
    }
    if (parts[1] !== 'boards') fail(404, 'NOT_FOUND', 'Ressource introuvable.');
    if (parts.length === 2) {
      if (req.method === 'GET') {
        const session = authenticate(req);
        const boards = db.prepare('SELECT b.id,b.title,b.description,m.role,b.updated_at AS updatedAt,b.object_count AS objectCount FROM boards b JOIN members m ON m.board_id=b.id WHERE m.user_id=? ORDER BY b.updated_at DESC').all(session.user.id);
        return json(res, 200, { boards });
      }
      if (req.method === 'POST') {
        const body = await readJSON(req);
        const session = authenticate(req);
        if (!body.board || typeof body.board !== 'object' || Array.isArray(body.board)) fail(400, 'INVALID_BOARD', 'Le document du projet est requis.');
        const id = randomUUID();
        let board, doc;
        try { board = validateBoard({ ...body.board, id, updatedAt: iso() }); doc = docFromBoard(board); board = boardFromDoc(doc, id, { updatedAt: board.updatedAt }); }
        catch (error) { fail(400, 'INVALID_BOARD', error.message); }
        try {
          boardAssets(board);
          const state = Buffer.from(Y.encodeStateAsUpdate(doc));
          if (state.length > MAX_STATE_BYTES) fail(413, 'PAYLOAD_TOO_LARGE', 'Le projet est trop volumineux.');
          transaction(db, () => {
            quotas.assertCreate(session.user.id, id, state.length);
            db.prepare('INSERT INTO boards(id,title,description,state,revision,updated_at,object_count,creator_id) VALUES(?,?,?,?,?,?,?,?)').run(id, board.title, board.description, state, 0, board.updatedAt, board.objects.length, session.user.id);
            db.prepare('INSERT INTO members VALUES(?,?,?,?)').run(id, session.user.id, 'owner', board.updatedAt);
          });
          cacheRoom({ id, doc, board, state, revision: 0, updatedAt: board.updatedAt, sockets: new Set() });
          return json(res, 201, boardPayload(id, 'owner'));
        } catch (error) { doc.destroy(); throw error; }
      }
      fail(405, 'METHOD_NOT_ALLOWED', 'Méthode non prise en charge.');
    }
    const boardId = requireId(parts[2]);
    if (parts.length === 3) {
      const session = authenticate(req);
      if (req.method === 'GET') return json(res, 200, boardPayload(boardId, membership(boardId, session.user.id)));
      if (req.method === 'DELETE') {
        membership(boardId, session.user.id, 'owner');
        const assets = db.prepare('SELECT id FROM assets WHERE board_id=?').all(boardId);
        transaction(db, () => {
          quotas.holdDeletedAssets(boardId);
          db.prepare('DELETE FROM boards WHERE id=?').run(boardId);
        });
        const room = rooms.get(boardId);
        if (room) { for (const socket of room.sockets) socket.close(1008, 'Projet supprimé.'); room.doc.destroy(); rooms.delete(boardId); }
        await Promise.all(assets.map(asset => quotas.cleanupAsset(asset.id)));
        return json(res, 200, { ok: true });
      }
      fail(405, 'METHOD_NOT_ALLOWED', 'Méthode non prise en charge.');
    }
    if (parts[3] === 'invitations') {
      if (parts.length === 4 && req.method === 'POST') {
        const body = await readJSON(req, 4096);
        const session = authenticate(req);
        membership(boardId, session.user.id, 'owner');
        if (!ROLES.includes(body.role)) fail(400, 'INVALID_ROLE', 'Choisissez un rôle propriétaire, éditeur ou lecteur.');
        const days = body.expiresInDays ?? 7;
        if (!Number.isInteger(days) || days < 1 || days > 30) fail(400, 'INVALID_EXPIRY', 'La durée d’invitation doit être comprise entre 1 et 30 jours.');
        const id = randomUUID();
        const token = randomToken();
        const expiresAt = now() + days * DAY;
        db.prepare('INSERT INTO invitations VALUES(?,?,?,?,?,?,NULL)').run(id, boardId, hash(token), body.role, iso(), expiresAt);
        return json(res, 201, { id, token, role: body.role, expiresAt: new Date(expiresAt).toISOString() });
      }
      const session = authenticate(req);
      membership(boardId, session.user.id, 'owner');
      if (parts.length === 4 && req.method === 'GET') return json(res, 200, { invitations: db.prepare('SELECT * FROM invitations WHERE board_id=? ORDER BY created_at DESC').all(boardId).map(invitationMeta) });
      if (parts.length === 5 && req.method === 'DELETE') {
        const inviteId = requireId(parts[4]);
        const result = db.prepare('UPDATE invitations SET revoked_at=? WHERE id=? AND board_id=?').run(iso(), inviteId, boardId);
        if (!result.changes) fail(404, 'NOT_FOUND', 'Invitation introuvable.');
        return json(res, 200, { ok: true });
      }
    }
    if (parts[3] === 'members') {
      if (parts.length === 5 && req.method === 'PATCH') {
        const body = await readJSON(req, 4096);
        const session = authenticate(req);
        membership(boardId, session.user.id, 'owner');
        const userId = requireId(parts[4]);
        if (!ROLES.includes(body.role)) fail(400, 'INVALID_ROLE', 'Rôle de participant invalide.');
        transaction(db, () => {
          ensureOwnerRemains(boardId, userId, body.role);
          db.prepare('UPDATE members SET role=? WHERE board_id=? AND user_id=?').run(body.role, boardId, userId);
        });
        changeMemberSockets(boardId, userId, body.role);
        return json(res, 200, { ok: true, role: body.role });
      }
      const session = authenticate(req);
      if (parts.length === 4 && req.method === 'GET') {
        membership(boardId, session.user.id);
        const members = db.prepare('SELECT u.id,u.name,u.color,m.role,m.joined_at AS joinedAt FROM members m JOIN users u ON u.id=m.user_id WHERE m.board_id=? ORDER BY m.joined_at').all(boardId).map(member => ({ ...member, isYou: member.id === session.user.id }));
        return json(res, 200, { members });
      }
      if (parts.length === 5 && req.method === 'DELETE') {
        membership(boardId, session.user.id, 'owner');
        const userId = requireId(parts[4]);
        transaction(db, () => {
          ensureOwnerRemains(boardId, userId, null);
          db.prepare('DELETE FROM members WHERE board_id=? AND user_id=?').run(boardId, userId);
        });
        changeMemberSockets(boardId, userId, null);
        return json(res, 200, { ok: true });
      }
    }
    if (parts[3] === 'assets') {
      if (parts.length === 4 && req.method === 'POST') {
        const session = authenticate(req);
        membership(boardId, session.user.id, 'editor');
        if (!limiter.allow(`assets:${session.user.id}`, 30)) fail(429, 'RATE_LIMIT', 'Trop d’images envoyées. Réessayez dans un instant.');
        const bytes = await readBody(req, 5 * 1024 * 1024);
        authenticate(req);
        membership(boardId, session.user.id, 'editor');
        const detected = imageMime(bytes);
        const supplied = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!detected || supplied !== detected) fail(415, 'INVALID_IMAGE', 'Envoyez une véritable image PNG, JPEG, WebP ou GIF avec son type de contenu.');
        const id = randomUUID();
        const target = join(dataDir, 'assets', id);
        const temporaryName = `${id}.${randomUUID()}.tmp`;
        const temporary = join(dataDir, 'assets', temporaryName);
        if (req.aborted || res.destroyed) fail(400, 'REQUEST_ABORTED', 'L’envoi de l’image a été annulé.');
        // Reserve before the first filesystem await. Concurrent uploads, board
        // creation and live edits all see this durable reservation.
        quotas.reserveAsset({ id, boardId, size: bytes.length, temporary: temporaryName });
        let committed = false;
        try {
          const file = await open(temporary, 'wx', 0o600);
          try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
          await rename(temporary, target);
          const directory = await open(join(dataDir, 'assets'), 'r');
          try { await directory.sync(); } finally { await directory.close(); }
          transaction(db, () => {
            if (req.aborted || res.destroyed) fail(400, 'REQUEST_ABORTED', 'L’envoi de l’image a été annulé.');
            authenticate(req);
            membership(boardId, session.user.id, 'editor');
            db.prepare('INSERT INTO assets VALUES(?,?,?,?,?)').run(id, boardId, detected, bytes.length, iso());
            quotas.completeAsset(id);
          });
          committed = true;
        } finally {
          if (!committed) await quotas.cleanupAsset(id);
        }
        return json(res, 201, { src: `/api/boards/${boardId}/assets/${id}` });
      }
      if (parts.length === 5 && ['GET', 'HEAD'].includes(req.method)) {
        const session = authenticate(req);
        membership(boardId, session.user.id);
        const id = requireId(parts[4]);
        const asset = db.prepare('SELECT * FROM assets WHERE id=? AND board_id=?').get(id, boardId);
        if (!asset) fail(404, 'NOT_FOUND', 'Image introuvable.');
        const bytes = await readFile(join(dataDir, 'assets', id));
        authenticate(req);
        membership(boardId, session.user.id);
        res.writeHead(200, { 'Content-Type': asset.mime, 'Content-Length': bytes.length, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
    }
    fail(404, 'NOT_FOUND', 'Ressource introuvable.');
  }

  async function serveStatic(pathname, req, res) {
    if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED', 'Méthode non prise en charge.');
    if (pathname.includes('\0') || pathname.includes('\\')) fail(404, 'NOT_FOUND', 'Ressource introuvable.');
    const target = resolve(staticDir, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!target.startsWith(staticDir + sep)) fail(404, 'NOT_FOUND', 'Ressource introuvable.');
    let path = target;
    try { if (!(await stat(path)).isFile()) fail(404, 'NOT_FOUND', 'Ressource introuvable.'); }
    catch (error) {
      if (error instanceof ApiError || extname(pathname)) throw error;
      path = join(staticDir, 'index.html');
    }
    const bytes = await readFile(path);
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.writeHead(200, { 'Content-Type': STATIC_MIME[extname(path)] || 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  const activeRequests = new Set();
  const server = http.createServer((req, res) => {
    if (closed) return json(res, 503, { error: 'SERVER_CLOSING', code: 'SERVER_CLOSING', message: 'Le serveur redémarre. Réessayez dans un instant.' });
    const pending = route(req, res).catch(error => {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof ApiError) return json(res, error.status, { error: error.code, code: error.code, message: error.message });
      if (error.code === 'ENOENT') return json(res, 404, { error: 'NOT_FOUND', code: 'NOT_FOUND', message: 'Ressource introuvable.' });
      console.error('Atelier request failed:', error.message);
      json(res, 503, { error: 'SAVE_FAILED', code: 'SAVE_FAILED', message: 'Le serveur ne peut pas enregistrer cette action. Réessayez dans un instant.' });
    }).finally(() => activeRequests.delete(pending));
    activeRequests.add(pending);
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 6 * 1024 * 1024, perMessageDeflate: false });

  function syncMessage(socket, vector = null) {
    const room = socket.room;
    let state = room.state;
    if (vector) {
      try { state = Y.encodeStateAsUpdate(room.doc, decodeUpdate(vector, 128 * 1024)); }
      catch (error) { fail(400, 'INVALID_UPDATE', error.message); }
    }
    return { type: 'sync', state: base64(state), vector: base64(Y.encodeStateVector(room.doc)), revision: room.revision, role: socket.role, user: socket.user, users: roomUsers(room), updatedAt: room.updatedAt };
  }
  function votePermissions(before, after, userId) {
    const oldObjects = new Map(before.objects.map(object => [object.id, object]));
    for (const object of after.objects) {
      let previous = oldObjects.get(object.id);
      if (!previous) {
        // Y.UndoManager restores deleted objects. Keep their existing foreign votes
        // without allowing an editor to invent voters on a newly created object.
        const deleted = db.prepare('SELECT votes FROM deleted_votes WHERE board_id=? AND object_id=?').get(before.id, object.id);
        if (deleted) previous = { votes: JSON.parse(deleted.votes) };
        else {
          if (Object.keys(object.votes || {}).some(actor => actor !== userId)) fail(403, 'VOTE_FORBIDDEN', 'Vous pouvez voter uniquement avec votre identité.');
          continue;
        }
      }
      for (const actor of new Set([...Object.keys(previous.votes || {}), ...Object.keys(object.votes || {})])) {
        if (actor !== userId && previous.votes?.[actor] !== object.votes?.[actor]) fail(403, 'VOTE_FORBIDDEN', 'Vous ne pouvez pas modifier les votes des autres participants.');
      }
    }
  }
  function receiveUpdate(socket, message) {
    if (!UUID.test(message.id || '')) fail(400, 'INVALID_UPDATE', 'Identifiant de mise à jour invalide.');
    if (!isEditor(socket.role)) fail(403, 'READ_ONLY', 'Ce projet est en lecture seule pour vous.');
    const update = decodeUpdate(message.update);
    const updateHash = hash(update);
    const room = socket.room;
    const previous = db.prepare('SELECT * FROM updates WHERE board_id=? AND id=?').get(room.id, message.id);
    if (previous) {
      if (previous.hash !== updateHash || previous.user_id !== socket.user.id) fail(409, 'UPDATE_ID_CONFLICT', 'Cette mise à jour porte un identifiant déjà utilisé.');
      send(socket, { type: 'ack', id: message.id, revision: previous.revision, updatedAt: previous.created_at });
      return;
    }
    const candidate = new Y.Doc();
    let adopted = false;
    try {
      let board, state;
      try {
        Y.applyUpdate(candidate, room.state);
        Y.applyUpdate(candidate, update);
        board = boardFromDoc(candidate, room.id, { updatedAt: iso() });
        votePermissions(room.board, board, socket.user.id);
        boardAssets(board);
        state = Buffer.from(Y.encodeStateAsUpdate(candidate));
        if (state.length > MAX_STATE_BYTES) fail(413, 'PAYLOAD_TOO_LARGE', 'Le projet synchronisé est trop volumineux.');
      } catch (error) {
        if (error instanceof ApiError) throw error;
        fail(400, 'INVALID_UPDATE', error.message || 'Mise à jour invalide.');
      }
      const changed = !state.equals(room.state);
      const revision = room.revision + (changed ? 1 : 0);
      const updatedAt = changed ? board.updatedAt : room.updatedAt;
      transaction(db, () => {
        if (changed) {
          quotas.assertState(room.id, state.length);
          const retained = new Set(board.objects.map(object => object.id));
          for (const deleted of room.board.objects) {
            if (!retained.has(deleted.id)) {
              if (Object.keys(deleted.votes || {}).length) db.prepare('INSERT INTO deleted_votes VALUES(?,?,?) ON CONFLICT(board_id,object_id) DO UPDATE SET votes=excluded.votes').run(room.id, deleted.id, JSON.stringify(deleted.votes));
              else db.prepare('DELETE FROM deleted_votes WHERE board_id=? AND object_id=?').run(room.id, deleted.id);
            }
          }
          db.prepare('UPDATE boards SET title=?,description=?,state=?,revision=?,updated_at=?,object_count=? WHERE id=?').run(board.title, board.description, state, revision, updatedAt, board.objects.length, room.id);
        }
        db.prepare('INSERT INTO updates VALUES(?,?,?,?,?,?)').run(room.id, message.id, updateHash, socket.user.id, revision, updatedAt);
        // Keep retry acknowledgements bounded. Older Yjs updates still replay
        // idempotently against the complete durable document snapshot.
        db.prepare(`DELETE FROM updates WHERE board_id=? AND rowid NOT IN (
          SELECT rowid FROM updates WHERE board_id=? ORDER BY rowid DESC LIMIT ?
        )`).run(room.id, room.id, MAX_RETAINED_UPDATES);
      });
      if (changed) {
        const previousDoc = room.doc;
        room.doc = candidate; room.board = board; room.state = state; room.revision = revision; room.updatedAt = updatedAt;
        adopted = true;
        previousDoc.destroy();
        broadcast(room, { type: 'update', update: message.update, revision, updatedAt }, socket);
      }
      send(socket, { type: 'ack', id: message.id, revision, updatedAt });
    } finally { if (!adopted) candidate.destroy(); }
  }
  function receivePresence(socket, message) {
    if (!limiter.allow(`presence:${socket.connectionId}`, 25, 1000)) return;
    const cursor = message.cursor ?? null;
    if (cursor !== null && (!cursor || typeof cursor !== 'object' || typeof cursor.x !== 'number' || typeof cursor.y !== 'number' || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y) || Math.abs(cursor.x) > 1e8 || Math.abs(cursor.y) > 1e8)) fail(400, 'INVALID_PRESENCE', 'Position du curseur invalide.');
    const selection = message.selection ?? [];
    if (!Array.isArray(selection) || selection.length > 100 || selection.some(id => !objectId(id))) fail(400, 'INVALID_PRESENCE', 'Sélection invalide.');
    const editing = message.editing ?? null;
    if (editing !== null && !objectId(editing)) fail(400, 'INVALID_PRESENCE', 'Édition active invalide.');
    socket.presence = { cursor: cursor ? { x: cursor.x, y: cursor.y } : null, selection: [...new Set(selection)], editing };
    socket.presenceAt = now();
    presence(socket.room);
  }
  function denyLive(req, socket, head, code, message) {
    // Browsers hide HTTP upgrade failures as 1006. An explicit policy close
    // lets a disconnected editor preserve its draft and stop reconnecting.
    // This socket never joins a room or receives any project data/presence.
    wss.handleUpgrade(req, socket, head, client => {
      client.on('error', () => {});
      send(client, { type: 'error', code, message });
      client.close(1008, message);
      const timeout = setTimeout(() => client.terminate(), 1000);
      timeout.unref();
      client.once('close', () => clearTimeout(timeout));
    });
  }
  server.on('upgrade', (req, socket, head) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const match = /^\/api\/boards\/([0-9a-f-]{36})\/live$/i.exec(pathname);
      if (!match) fail(404, 'NOT_FOUND', 'Connexion introuvable.');
      checkOrigin(req, true);
      if (!limiter.allow(`websocket:${requestIP(req)}`, 60)) fail(429, 'RATE_LIMIT', 'Trop de connexions.');
      const boardId = requireId(match[1]);
      let session, role;
      try { session = authenticate(req); role = membership(boardId, session.user.id); }
      catch (error) {
        if (error instanceof ApiError && error.code === 'SESSION_REQUIRED') return denyLive(req, socket, head, 'SESSION_REQUIRED', 'Votre session est absente ou expirée.');
        if (error instanceof ApiError && error.code === 'BOARD_NOT_FOUND') return denyLive(req, socket, head, 'FORBIDDEN', 'Projet introuvable ou accès retiré.');
        throw error;
      }
      const room = getRoom(boardId);
      if ([...room.sockets].filter(client => client.user.id === session.user.id).length >= 12) fail(429, 'RATE_LIMIT', 'Trop de connexions simultanées pour ce participant.');
      wss.handleUpgrade(req, socket, head, client => {
        client.room = room; client.role = role; client.user = { ...session.user }; client.tokenHash = session.tokenHash;
        client.expiresAt = session.expiresAt; client.connectionId = randomUUID(); client.isAlive = true;
        client.presence = { cursor: null, selection: [], editing: null }; client.presenceAt = now();
        room.sockets.add(client);
        send(client, syncMessage(client));
        presence(room);
        client.on('pong', () => { client.isAlive = true; });
        client.on('message', (data, isBinary) => {
          let message;
          try {
            if (isBinary) fail(400, 'INVALID_MESSAGE', 'Une commande JSON est attendue.');
            try { message = JSON.parse(data.toString()); }
            catch { fail(400, 'INVALID_MESSAGE', 'La commande JSON est invalide.'); }
            if (!message || typeof message !== 'object' || Array.isArray(message)) fail(400, 'INVALID_MESSAGE', 'Commande invalide.');
            if (client.expiresAt <= now() || !db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(client.tokenHash, now())) { client.close(1008, 'Session expirée.'); return; }
            client.role = membership(room.id, client.user.id);
            if (message.type === 'presence') receivePresence(client, message);
            else if (message.type === 'update') {
              if (!limiter.allow(`update:${client.user.id}`, 120, 1000)) fail(429, 'RATE_LIMIT', 'Trop de modifications. Réessayez dans un instant.');
              receiveUpdate(client, message);
            } else if (message.type === 'sync') send(client, syncMessage(client, message.vector || null));
            else fail(400, 'INVALID_MESSAGE', 'Commande de synchronisation inconnue.');
          } catch (error) {
            const code = error instanceof ApiError ? error.code : 'SAVE_FAILED';
            const errorMessage = error instanceof ApiError ? error.message : 'Le serveur ne peut pas enregistrer cette modification. Elle reste en attente.';
            if (!(error instanceof ApiError)) console.error('Atelier synchronization failed:', error.message);
            send(client, { type: 'error', code, message: errorMessage, ...(typeof message?.id === 'string' && message.id.length <= 128 ? { id: message.id } : {}) });
            if (code === 'BOARD_NOT_FOUND' || code === 'SESSION_REQUIRED') client.close(1008, errorMessage);
          }
        });
        client.on('close', () => {
          room.sockets.delete(client);
          presence(room);
          if (!room.sockets.size && rooms.get(room.id) === room) { room.doc.destroy(); rooms.delete(room.id); }
        });
        client.on('error', () => { /* Close handler removes ephemeral presence. */ });
      });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 503;
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      let expiredPresence = false;
      for (const socket of room.sockets) {
        if (!socket.isAlive) { socket.terminate(); continue; }
        if (socket.expiresAt <= now()) { socket.close(1008, 'Session expirée.'); continue; }
        socket.isAlive = false; socket.ping();
        if (now() - socket.presenceAt > 30000 && (socket.presence.cursor || socket.presence.selection.length || socket.presence.editing)) {
          socket.presence = { cursor: null, selection: [], editing: null }; expiredPresence = true;
        }
      }
      if (expiredPresence) presence(room);
    }
  }, 15000);
  heartbeat.unref();

  function address() {
    const bound = server.address();
    if (!bound || typeof bound === 'string') return null;
    const connectHost = bound.address === '0.0.0.0' || bound.address === '::' ? '127.0.0.1' : bound.address;
    return { port: bound.port, host: bound.address, url: publicOrigin || `http://${connectHost.includes(':') ? `[${connectHost}]` : connectHost}:${bound.port}` };
  }
  async function start() {
    if (closed) throw new Error('Le serveur a été fermé.');
    if (!started) {
      await new Promise((resolveStart, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolveStart(); });
      });
      started = true;
    }
    return address();
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      await new Promise(resolveClose => wss.close(resolveClose));
      if (started) await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
      // An aborted HTTP socket can close before its asynchronous file write has
      // finished. Wait for the route's rollback/cleanup before closing SQLite or
      // allowing a replacement process to reconcile its reservations.
      await Promise.allSettled([...activeRequests]);
      for (const room of rooms.values()) room.doc.destroy();
      rooms.clear();
      db.close();
    })();
    return closePromise;
  }
  return { server, start, close, address };
}
