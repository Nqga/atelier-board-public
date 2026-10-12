import { createHash, randomBytes } from 'node:crypto';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const COOKIE = 'atelier_session';
export const ROLES = ['viewer', 'editor', 'owner'];
export const randomToken = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new ApiError(status, code, message); };
export function requireId(id) {
  if (!UUID.test(id)) fail(404, 'NOT_FOUND', 'Ressource introuvable.');
  return id;
}
export function nameOf(value) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) fail(400, 'INVALID_NAME', 'Choisissez un prénom ou un pseudonyme de 1 à 80 caractères.');
  return value.trim();
}
export function cookieToken(req) {
  const cookies = (req.headers.cookie || '').split(';');
  const raw = cookies.find(item => item.trim().startsWith(`${COOKIE}=`))?.trim().slice(COOKIE.length + 1);
  return raw && TOKEN.test(raw) ? raw : null;
}
export function decodeUpdate(value, maxBytes = 4 * 1024 * 1024) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail(400, 'INVALID_UPDATE', 'Mise à jour de synchronisation invalide.');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maxBytes) fail(413, 'PAYLOAD_TOO_LARGE', 'Mise à jour trop volumineuse.');
  return bytes;
}
export async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) fail(413, 'PAYLOAD_TOO_LARGE', 'Le fichier ou le document est trop volumineux.');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) fail(413, 'PAYLOAD_TOO_LARGE', 'Le fichier ou le document est trop volumineux.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}
export async function readJSON(req, limit = 24 * 1024 * 1024) {
  if ((req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') fail(415, 'JSON_REQUIRED', 'Un document JSON est attendu.');
  try {
    const body = JSON.parse((await readBody(req, limit)).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_JSON', 'Le document JSON doit être un objet.');
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(400, 'INVALID_JSON', 'Le document JSON est invalide.');
  }
}
export function imageMime(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  return null;
}

export class RateLimiter {
  constructor(now) { this.now = now; this.entries = new Map(); }
  allow(key, limit, window = 60000) {
    const time = this.now();
    let entry = this.entries.get(key);
    if (!entry || time - entry.start >= window) { entry = { start: time, count: 0 }; this.entries.set(key, entry); }
    if (this.entries.size > 10000) {
      for (const [storedKey, value] of this.entries) if (time - value.start > 60000) this.entries.delete(storedKey);
      if (this.entries.size > 10000) this.entries.delete(this.entries.keys().next().value);
    }
    return ++entry.count <= limit;
  }
}
