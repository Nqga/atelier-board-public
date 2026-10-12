import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

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
      revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, object_count INTEGER NOT NULL
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
    CREATE INDEX IF NOT EXISTS member_user ON members(user_id);
    CREATE INDEX IF NOT EXISTS invitation_board ON invitations(board_id);
    CREATE INDEX IF NOT EXISTS asset_board ON assets(board_id);`);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch { /* Original error is more useful. */ } throw error; }
}
