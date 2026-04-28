import { db } from "./db.js";
import os from "node:os";
import { queueStats } from "./queue.js";
import { state } from "./state.js";

export function topModelsTable(limit = 10): string {
  const rows = db
    .prepare(
      "SELECT model, COUNT(*) AS n FROM images GROUP BY model ORDER BY n DESC LIMIT ?",
    )
    .all(limit) as { model: string; n: number }[];
  if (!rows.length) return "No images yet.";
  return ["Top models:", ...rows.map((r, i) => `${i + 1}. ${r.model} — ${r.n}`)].join("\n");
}

export function topUsersTable(limit = 10): string {
  const rows = db
    .prepare(
      `SELECT i.user_id, COUNT(*) AS n, u.username
         FROM images i
         LEFT JOIN users u ON u.user_id = i.user_id
        GROUP BY i.user_id
        ORDER BY n DESC
        LIMIT ?`,
    )
    .all(limit) as { user_id: number; n: number; username: string | null }[];
  if (!rows.length) return "No users yet.";
  return [
    "Top users:",
    ...rows.map(
      (r, i) => `${i + 1}. ${r.user_id} (@${r.username ?? "—"}) — ${r.n}`,
    ),
  ].join("\n");
}

export function analyticsSummary(): string {
  const totalUsers = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as {
    n: number;
  }).n;
  const banned = (db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE banned = 1")
    .get() as { n: number }).n;
  const totalImages = (db.prepare("SELECT COUNT(*) AS n FROM images").get() as {
    n: number;
  }).n;
  const last24h = (db
    .prepare("SELECT COUNT(*) AS n FROM images WHERE created_at > ?")
    .get(Date.now() - 24 * 3600 * 1000) as { n: number }).n;
  const totalCredits = (db
    .prepare("SELECT COALESCE(SUM(credits),0) AS n FROM users")
    .get() as { n: number }).n;
  return (
    `Analytics\n` +
    `Users: ${totalUsers} (banned ${banned})\n` +
    `Images total: ${totalImages}\n` +
    `Images 24h: ${last24h}\n` +
    `Credits in circulation: ${totalCredits}`
  );
}

export function serverStats(): string {
  const mem = process.memoryUsage();
  const q = queueStats();
  return (
    `Server\n` +
    `Uptime: ${Math.round(process.uptime())}s\n` +
    `Node: ${process.version}\n` +
    `RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} MB\n` +
    `Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB\n` +
    `Load avg: ${os.loadavg().map((n) => n.toFixed(2)).join(" ")}\n` +
    `Queue: pending=${q.pending} active=${q.active} killed=${q.killed}\n` +
    `Maint: ${state.maintenance} · Locked: ${state.locked} · Panic: ${state.panic}`
  );
}
