import * as Y from './vendor/yjs.js';
import { validateBoard, DOCUMENT_LIMITS } from './store.js';

export { Y };
const ROOTS = new Set(['meta', 'objects']);
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

export function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return globalThis.btoa(binary);
}
export function decodeBase64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('État de synchronisation invalide.');
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Preserve unchanged characters so simultaneous edits merge in Y.Text. */
export function replaceYText(text, next) {
  if (!(text instanceof Y.Text) || typeof next !== 'string' || next.length > DOCUMENT_LIMITS.text) throw new Error('Texte invalide ou trop long.');
  const previous = text.toString();
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  const splitsSurrogate = (value, position) => position > 0 && position < value.length && /[\uD800-\uDBFF]/.test(value[position - 1]) && /[\uDC00-\uDFFF]/.test(value[position]);
  if (splitsSurrogate(previous, start) || splitsSurrogate(next, start)) start--;
  let beforeEnd = previous.length, nextEnd = next.length;
  while (beforeEnd > start && nextEnd > start && previous[beforeEnd - 1] === next[nextEnd - 1]) { beforeEnd--; nextEnd--; }
  if (splitsSurrogate(previous, beforeEnd) || splitsSurrogate(next, nextEnd)) { beforeEnd++; nextEnd++; }
  const change = () => {
    if (beforeEnd > start) text.delete(start, beforeEnd - start);
    if (nextEnd > start) text.insert(start, next.slice(start, nextEnd));
  };
  if (text.doc) text.doc.transact(change); else change();
  return previous !== next;
}

export function objectToShared(object) {
  const map = new Y.Map();
  for (const [key, value] of Object.entries(object)) {
    if (key === 'id' || key === 'text' || key === 'votes') continue;
    map.set(key, structuredClone(value));
  }
  const text = new Y.Text();
  if (object.text) text.insert(0, object.text);
  map.set('text', text);
  map.set('votes', new Y.Map(Object.entries(object.votes || {}).map(([actor, count]) => [actor, count > 0 ? 1 : 0])));
  return map;
}

export function docFromBoard(value) {
  const board = validateBoard(value);
  const doc = new Y.Doc();
  doc.transact(() => {
    const meta = doc.getMap('meta');
    meta.set('title', board.title);
    meta.set('description', board.description);
    const objects = doc.getMap('objects');
    for (const object of board.objects) objects.set(object.id, objectToShared(object));
  });
  return doc;
}

function requireMap(value, name) {
  if (!(value instanceof Y.Map) || value.constructor !== Y.Map || value._start !== null) throw new Error(`${name} doit être une table de synchronisation.`);
  return value;
}
function jsonValue(value, depth = 0) {
  if (depth > 8 || value instanceof Y.AbstractType) throw new Error('Propriété partagée invalide.');
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 10000) throw new Error('Liste partagée trop longue.');
    return value.map(item => jsonValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Propriété partagée non JSON.');
  const result = {};
  if (Object.keys(value).length > 1000) throw new Error('Propriété partagée trop volumineuse.');
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN.has(key) || key.length > 128) throw new Error('Clé partagée non autorisée.');
    result[key] = jsonValue(item, depth + 1);
  }
  return result;
}

/** Validate the complete Yjs structure before accepting an untrusted update. */
export function boardFromDoc(doc, boardId, { updatedAt = new Date().toISOString() } = {}) {
  if (!(doc instanceof Y.Doc) || doc.store.pendingStructs || doc.store.pendingDs) throw new Error('État de synchronisation incomplet.');
  // Empty root maps have no encoded structs; hydrate the two named maps first.
  const meta = requireMap(doc.getMap('meta'), 'Métadonnées');
  const objects = requireMap(doc.getMap('objects'), 'Objets');
  if (doc.share.size !== 2 || [...doc.share.keys()].some(key => !ROOTS.has(key))) throw new Error('Racine de synchronisation non autorisée.');
  if (meta.size !== 2 || [...meta.keys()].some(key => !['title', 'description'].includes(key))) throw new Error('Métadonnée de synchronisation non autorisée.');
  if (typeof meta.get('title') !== 'string' || typeof meta.get('description') !== 'string') throw new Error('Métadonnée invalide.');
  if (objects.size > DOCUMENT_LIMITS.objects) throw new Error('Trop d’objets partagés.');
  const plainObjects = [];
  for (const [id, value] of objects.entries()) {
    const object = requireMap(value, 'Objet');
    if (object.size > 100 || object.has('id')) throw new Error('Identifiant partagé immuable ou objet trop volumineux.');
    const text = object.get('text');
    if (!(text instanceof Y.Text) || text.constructor !== Y.Text || text._map.size > 0 || text.toDelta().some(item => typeof item.insert !== 'string' || (item.attributes && Object.keys(item.attributes).length))) throw new Error('Texte partagé invalide.');
    const votes = requireMap(object.get('votes'), 'Votes');
    if (votes.size > 1000) throw new Error('Trop de votes partagés.');
    const plainVotes = {};
    for (const [actor, count] of votes.entries()) {
      if (FORBIDDEN.has(actor) || (count !== 0 && count !== 1)) throw new Error('Vote partagé invalide.');
      plainVotes[actor] = count;
    }
    const plain = { id };
    for (const [key, item] of object.entries()) {
      if (FORBIDDEN.has(key) || key.length > 128) throw new Error('Clé partagée non autorisée.');
      if (key !== 'text' && key !== 'votes') plain[key] = jsonValue(item);
    }
    plain.text = text.toString();
    plain.votes = plainVotes;
    plainObjects.push(plain);
  }
  return validateBoard({ id: boardId, title: meta.get('title'), description: meta.get('description'), objects: plainObjects, updatedAt });
}
