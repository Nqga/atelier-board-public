import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export const MAX_RETAINED_UPDATES = 1000;

export function openDatabase(dataDir) {
  const db = new DatabaseSync(join(dataDir, 'atelier.sqlite'));
  db.exec(`PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, state BLOB NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, object_count INTEGER NOT NULL,
      creator_id TEXT REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS members (
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')), joined_at TEXT NOT NULL,
      PRIMARY KEY(board_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
      created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS updates (
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      id TEXT NOT NULL, hash TEXT NOT NULL, user_id TEXT NOT NULL,
      revision INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(board_id,id)
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deleted_votes (
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      object_id TEXT NOT NULL, votes TEXT NOT NULL,
      PRIMARY KEY(board_id,object_id)
    );
    CREATE TABLE IF NOT EXISTS asset_cleanup (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0),
      temporary TEXT
    );
    CREATE TABLE IF NOT EXISTS orphan_files (
      path TEXT PRIMARY KEY, size INTEGER NOT NULL CHECK(size >= 0)
    );
    CREATE INDEX IF NOT EXISTS member_user ON members(user_id);
    CREATE INDEX IF NOT EXISTS invitation_board ON invitations(board_id);
    CREATE INDEX IF NOT EXISTS asset_board ON assets(board_id);`);
  // An invitation or a transfer of ownership must not reset a guest's quota.
  // Older boards have no creator column: retain their earliest known owner.
  if (!db.prepare('PRAGMA table_info(boards)').all().some(column => column.name === 'creator_id')) {
    db.exec('ALTER TABLE boards ADD COLUMN creator_id TEXT REFERENCES users(id)');
  }
  transaction(db, () => {
    db.exec(`UPDATE boards SET creator_id=(
      SELECT user_id FROM members WHERE board_id=boards.id
      ORDER BY CASE WHEN role='owner' THEN 0 ELSE 1 END, joined_at, user_id LIMIT 1
    ) WHERE creator_id IS NULL;
    CREATE INDEX IF NOT EXISTS board_creator ON boards(creator_id);
    CREATE TRIGGER IF NOT EXISTS immutable_board_creator BEFORE UPDATE OF creator_id ON boards
      WHEN OLD.creator_id IS NOT NULL AND NEW.creator_id IS NOT OLD.creator_id
      BEGIN SELECT RAISE(ABORT, 'The original board creator is immutable'); END;`);
    db.prepare(`DELETE FROM updates WHERE rowid NOT IN (
      SELECT rowid FROM (
        SELECT rowid, ROW_NUMBER() OVER (PARTITION BY board_id ORDER BY rowid DESC) AS sequence
        FROM updates
      ) WHERE sequence <= ?
    )`).run(MAX_RETAINED_UPDATES);
    db.prepare("DELETE FROM deleted_votes WHERE votes='{}'").run();
  });
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch { /* Original error is more useful. */ } throw error; }
}
