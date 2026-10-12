import { readdir, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, UUID } from './security.mjs';
import { transaction } from './database.mjs';

export const DEFAULT_QUOTAS = Object.freeze({
  maxBoardsPerGuest: 20,
  maxBoardBytes: 100 * 1024 * 1024,
  maxStorageBytes: 1024 * 1024 * 1024,
});

export function normalizeQuotas(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Les quotas doivent être un objet.');
  const limits = { ...DEFAULT_QUOTAS };
  for (const key of Object.keys(DEFAULT_QUOTAS)) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw new TypeError(`Le quota ${key} doit être un entier strictement positif.`);
    limits[key] = value[key];
  }
  return Object.freeze(limits);
}

function exceeded(quota) {
  const messages = {
    maxBoardsPerGuest: 'Vous avez atteint le nombre maximal de projets créés. Supprimez un de vos projets avant d’en créer un autre.',
    maxBoardBytes: 'Ce projet a atteint sa limite de stockage. Cette modification n’a pas été enregistrée. Supprimez du contenu ou exportez votre brouillon.',
    maxStorageBytes: 'Le serveur a atteint sa limite de stockage. Cette modification n’a pas été enregistrée. Exportez votre brouillon ou réessayez après avoir libéré de l’espace.',
  };
  const error = new ApiError(quota === 'maxBoardsPerGuest' ? 409 : 413, 'QUOTA_EXCEEDED', messages[quota]);
  error.quota = quota;
  return error;
}

/** Logical document/asset bytes, not the physical size of SQLite or its WAL.
 * Upload reservations and cleanup debt live in SQLite so a crash cannot reset
 * the budget. Call checks within the same synchronous transaction as the write.
 */
export function createQuotaManager(db, dataDir, limits) {
  const assetsDir = join(dataDir, 'assets');
  const totalBytes = db.prepare(`SELECT
    COALESCE((SELECT SUM(length(state)) FROM boards),0) +
    COALESCE((SELECT SUM(size) FROM assets),0) +
    COALESCE((SELECT SUM(size) FROM asset_cleanup),0) +
    COALESCE((SELECT SUM(size) FROM orphan_files),0) AS bytes`);
  const boardBytes = db.prepare(`SELECT
    COALESCE((SELECT length(state) FROM boards WHERE id=?),0) +
    COALESCE((SELECT SUM(size) FROM assets WHERE board_id=?),0) +
    COALESCE((SELECT SUM(size) FROM asset_cleanup WHERE board_id=?),0) AS bytes`);

  function assertAddition(boardId, bytes) {
    // Reading, no-op acknowledgements and reductions remain possible when an
    // administrator lowers a limit below the amount already stored.
    if (bytes <= 0) return;
    const boardSize = boardBytes.get(boardId, boardId, boardId).bytes;
    if (!Number.isSafeInteger(boardSize) || boardSize > limits.maxBoardBytes - bytes) throw exceeded('maxBoardBytes');
    const totalSize = totalBytes.get().bytes;
    if (!Number.isSafeInteger(totalSize) || totalSize > limits.maxStorageBytes - bytes) throw exceeded('maxStorageBytes');
  }
  function assertCreate(creatorId, boardId, stateBytes) {
    const count = db.prepare('SELECT count(*) AS count FROM boards WHERE creator_id=?').get(creatorId).count;
    if (count >= limits.maxBoardsPerGuest) throw exceeded('maxBoardsPerGuest');
    assertAddition(boardId, stateBytes);
  }
  function assertState(boardId, stateBytes) {
    const previous = db.prepare('SELECT length(state) AS bytes FROM boards WHERE id=?').get(boardId);
    if (!previous) throw new ApiError(404, 'BOARD_NOT_FOUND', 'Projet introuvable.');
    assertAddition(boardId, stateBytes - previous.bytes);
  }
  function reserveAsset({ id, boardId, size, temporary }) {
    transaction(db, () => {
      assertAddition(boardId, size);
      db.prepare('INSERT INTO asset_cleanup(id,board_id,size,temporary) VALUES(?,?,?,?)').run(id, boardId, size, temporary);
    });
  }
  function completeAsset(id) {
    db.prepare('DELETE FROM asset_cleanup WHERE id=?').run(id);
  }
  function holdDeletedAssets(boardId) {
    db.prepare(`INSERT INTO asset_cleanup(id,board_id,size,temporary)
      SELECT id,board_id,size,NULL FROM assets WHERE board_id=?`).run(boardId);
  }
  function validTemporary(id, value) {
    return typeof value === 'string' && value.startsWith(`${id}.`) && UUID.test(value.slice(id.length + 1, -4)) && value.endsWith('.tmp');
  }
  async function cleanupAsset(id) {
    const entry = db.prepare('SELECT * FROM asset_cleanup WHERE id=?').get(id);
    if (!entry) return true;
    // Never interpret a corrupt database path as permission to remove another
    // file, and never remove a file belonging to a committed asset.
    if (!UUID.test(id) || (entry.temporary !== null && !validTemporary(id, entry.temporary))) return false;
    const committed = db.prepare('SELECT 1 FROM assets WHERE id=?').get(id);
    const paths = committed ? [] : [join(assetsDir, id)];
    if (entry.temporary) paths.push(join(assetsDir, entry.temporary));
    const results = await Promise.allSettled(paths.map(path => rm(path, { force: true })));
    if (results.some(result => result.status === 'rejected')) return false;
    db.prepare('DELETE FROM asset_cleanup WHERE id=?').run(id);
    return true;
  }
  async function reconcile() {
    // Only paths recorded by the application are eligible for cleanup. Keep
    // unknown files, account for their bytes, and leave any manual recovery to
    // the administrator. A lowered quota never prevents startup.
    for (const entry of db.prepare('SELECT id FROM asset_cleanup').all()) await cleanupAsset(entry.id);
    const assets = db.prepare('SELECT id FROM assets').all();
    const reserved = db.prepare('SELECT id,temporary FROM asset_cleanup').all();
    const tracked = new Set(assets.map(asset => asset.id));
    for (const entry of reserved) { tracked.add(entry.id); if (entry.temporary) tracked.add(entry.temporary); }
    const sizes = [];
    for (const asset of assets) {
      try { const file = await lstat(join(assetsDir, asset.id)); if (file.isFile()) sizes.push([file.size, asset.id]); }
      catch (error) { if (error.code !== 'ENOENT') throw error; sizes.push([0, asset.id]); }
    }
    const unknown = [];
    for (const file of await readdir(assetsDir, { withFileTypes: true })) {
      if (tracked.has(file.name) || !file.isFile()) continue;
      const info = await lstat(join(assetsDir, file.name));
      unknown.push([file.name, info.size]);
    }
    transaction(db, () => {
      for (const [size, id] of sizes) db.prepare('UPDATE assets SET size=? WHERE id=?').run(size, id);
      db.exec('DELETE FROM orphan_files');
      const insert = db.prepare('INSERT INTO orphan_files(path,size) VALUES(?,?)');
      for (const entry of unknown) insert.run(...entry);
    });
  }
  return { assertCreate, assertState, reserveAsset, completeAsset, holdDeletedAssets, cleanupAsset, reconcile };
}
