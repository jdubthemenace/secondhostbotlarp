import { DatabaseSync, type StatementSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, DB_PATH, STARTING_CREDITS } from "./config.js";
import { logger } from "./logger.js";

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const rawDb = new DatabaseSync(DB_PATH);
rawDb.exec("PRAGMA journal_mode = WAL");
rawDb.exec("PRAGMA foreign_keys = ON");
rawDb.exec("PRAGMA synchronous = NORMAL");
rawDb.exec("PRAGMA busy_timeout = 5000");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id     INTEGER PRIMARY KEY,
  username    TEXT,
  first_name  TEXT,
  role        TEXT NOT NULL DEFAULT 'user',
  plan        TEXT NOT NULL DEFAULT 'free',
  credits     INTEGER NOT NULL DEFAULT ${STARTING_CREDITS},
  banned      INTEGER NOT NULL DEFAULT 0,
  referrer_id INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS images (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  model         TEXT NOT NULL,
  message_id    INTEGER,
  file_unique   TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_user ON images(user_id);
CREATE INDEX IF NOT EXISTS idx_images_model ON images(model);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  meta       TEXT,
  timestamp  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_type ON logs(type);
CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_ts   ON logs(timestamp);

CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  message    TEXT NOT NULL,
  timestamp  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id);

CREATE TABLE IF NOT EXISTS processed_jobs (
  job_key    TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  timestamp  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

rawDb.exec(SCHEMA);

logger.info({ path: DB_PATH }, "sqlite ready");

/**
 * Lightweight wrapper that gives us a better-sqlite3-like API
 * on top of node:sqlite.
 */
export interface PreparedStatement {
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  get: <T = unknown>(...params: unknown[]) => T | undefined;
  all: <T = unknown>(...params: unknown[]) => T[];
}

class DbWrapper {
  prepare(sql: string): PreparedStatement {
    const stmt: StatementSync = rawDb.prepare(sql);
    return {
      run: (...params: unknown[]) => {
        const r = stmt.run(...(params as never[]));
        return {
          changes: Number(r.changes ?? 0),
          lastInsertRowid: r.lastInsertRowid as number | bigint,
        };
      },
      get: <T = unknown>(...params: unknown[]) =>
        stmt.get(...(params as never[])) as T | undefined,
      all: <T = unknown>(...params: unknown[]) =>
        stmt.all(...(params as never[])) as T[],
    };
  }

  exec(sql: string): void {
    rawDb.exec(sql);
  }

  /** Run `fn` inside an IMMEDIATE transaction; rolls back on throw. */
  transaction<T>(fn: () => T): () => T {
    return () => {
      rawDb.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        rawDb.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          rawDb.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw err;
      }
    };
  }
}

export const db = new DbWrapper();

export function nowMs(): number {
  return Date.now();
}

export function getSetting(key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get<{ value: string }>(key);
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function backupDatabase(targetPath: string): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(DB_PATH, targetPath);
}
