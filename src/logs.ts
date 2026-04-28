import { db, nowMs } from "./db.js";
import { logger } from "./logger.js";

export type LogType = "image" | "admin" | "credit" | "system" | "error";

export interface LogEntry {
  type: LogType;
  userId?: number | null;
  action: string;
  meta?: Record<string, unknown>;
}

export function writeLog(entry: LogEntry): void {
  try {
    db.prepare(
      "INSERT INTO logs(type, user_id, action, meta, timestamp) VALUES(?, ?, ?, ?, ?)",
    ).run(
      entry.type,
      entry.userId ?? null,
      entry.action,
      entry.meta ? JSON.stringify(entry.meta) : null,
      nowMs(),
    );
  } catch (err) {
    logger.error({ err }, "failed to persist log");
  }
}

export function recentLogs(limit = 50, type?: string) {
  if (type) {
    return db
      .prepare(
        "SELECT * FROM logs WHERE type = ? ORDER BY id DESC LIMIT ?",
      )
      .all(type, limit);
  }
  return db
    .prepare("SELECT * FROM logs ORDER BY id DESC LIMIT ?")
    .all(limit);
}

export function clearLogs(): number {
  const info = db.prepare("DELETE FROM logs").run();
  return info.changes;
}
