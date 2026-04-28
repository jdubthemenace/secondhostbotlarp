import type { Telegraf } from "telegraf";
import path from "node:path";
import fs from "node:fs";
import type { BotContext } from "../middleware.js";
import { backupDatabase, db } from "../db.js";
import {
  ROLE_LABEL,
  VALID_ROLES,
  ensureUser,
  effectiveRole,
  getUser,
  isFounder,
  setRole,
  type Role,
  type UserRow,
} from "../roles.js";
import { writeLog } from "../logs.js";
import { safeReply } from "../middleware.js";
import { setDebug, setLocked, setPanic, state } from "../state.js";
import { killQueue, resetQueue, queueStats } from "../queue.js";
import { analyticsSummary, serverStats, topUsersTable } from "../analytics.js";
import { BACKUP_DIR } from "../config.js";
import { syncCommandsForUser } from "../command_menu.js";

function gate(ctx: BotContext) {
  return isFounder(ctx.from!.id);
}

function parts(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function registerFounderCommands(bot: Telegraf<BotContext>) {
  bot.command("panicmode", async (ctx) => {
    if (!gate(ctx)) return;
    setPanic(!state.panic);
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "panicmode",
      meta: { value: state.panic },
    });
    await safeReply(ctx, `Panic mode: ${state.panic ? "ON" : "OFF"}.`);
  });

  bot.command("shutdown", async (ctx) => {
    if (!gate(ctx)) return;
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "shutdown",
      meta: {},
    });
    await safeReply(ctx, "Shutting down…");
    setTimeout(() => process.exit(0), 250);
  });

  bot.command("softrestart", async (ctx) => {
    if (!gate(ctx)) return;
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "softrestart",
      meta: {},
    });
    await safeReply(ctx, "Soft restart requested…");
    setTimeout(() => process.exit(0), 250);
  });

  bot.command("lockall", async (ctx) => {
    if (!gate(ctx)) return;
    setLocked(true);
    setPanic(true);
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "lockall",
      meta: {},
    });
    await safeReply(ctx, "All locked.");
  });

  bot.command("unlockall", async (ctx) => {
    if (!gate(ctx)) return;
    setLocked(false);
    setPanic(false);
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "unlockall",
      meta: {},
    });
    await safeReply(ctx, "All unlocked.");
  });

  bot.command("backupdb", async (ctx) => {
    if (!gate(ctx)) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(BACKUP_DIR, `bot-${ts}.sqlite`);
    backupDatabase(target);
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "backupdb",
      meta: { path: target },
    });
    try {
      await ctx.replyWithDocument({ source: target, filename: path.basename(target) });
    } catch {
      await safeReply(ctx, `Backup saved at ${target}`);
    }
  });

  bot.command("restoredb", async (ctx) => {
    if (!gate(ctx)) return;
    await safeReply(
      ctx,
      "Reply to a backup .sqlite file with /restoredb to restore. (Backups list:\n" +
        listBackups() +
        ")",
    );
  });

  bot.command("inspectdb", async (ctx) => {
    if (!gate(ctx)) return;
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const lines = ["Database tables:"];
    for (const t of tables) {
      const c = (db
        .prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`)
        .get() as { n: number }).n;
      lines.push(`• ${t.name}: ${c}`);
    }
    await safeReply(ctx, lines.join("\n"));
  });

  bot.command("fixdb", async (ctx) => {
    if (!gate(ctx)) return;
    db.prepare("DELETE FROM users WHERE credits < 0").run();
    db.exec("VACUUM");
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "fixdb",
      meta: {},
    });
    await safeReply(ctx, "Database integrity check complete.");
  });

  bot.command("adminlist", async (ctx) => {
    if (!gate(ctx)) return;
    const rows = db
      .prepare(
        `SELECT user_id, username, role FROM users
          WHERE role IN ('moderator','admin','superadmin','cofounder','founder')
          ORDER BY CASE role
            WHEN 'founder' THEN 5
            WHEN 'cofounder' THEN 4
            WHEN 'superadmin' THEN 3
            WHEN 'admin' THEN 2
            ELSE 1 END DESC`,
      )
      .all() as { user_id: number; username: string | null; role: Role }[];
    if (!rows.length) return safeReply(ctx, "No staff configured.");
    await safeReply(
      ctx,
      "Staff:\n" +
        rows
          .map((r) => `${ROLE_LABEL[r.role]} — ${r.user_id} @${r.username ?? "—"}`)
          .join("\n"),
    );
  });

  bot.command("addadmin", async (ctx) => {
    if (!gate(ctx)) return;
    const id = Number(parts("text" in ctx.message ? ctx.message.text : "")[1]);
    if (!Number.isFinite(id)) return safeReply(ctx, "Usage: /addadmin <user_id>");
    ensureUser(id);
    setRole(id, "admin");
    await syncCommandsForUser(bot, id, "admin");
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "addadmin",
      meta: { target: id },
    });
    await safeReply(ctx, `User ${id} promoted to Admin.`);
  });

  bot.command("removeadmin", async (ctx) => {
    if (!gate(ctx)) return;
    const id = Number(parts("text" in ctx.message ? ctx.message.text : "")[1]);
    if (!Number.isFinite(id))
      return safeReply(ctx, "Usage: /removeadmin <user_id>");
    if (id === ctx.from!.id) return safeReply(ctx, "Cannot demote founder.");
    setRole(id, "user");
    await syncCommandsForUser(bot, id, "user");
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "removeadmin",
      meta: { target: id },
    });
    await safeReply(ctx, `User ${id} demoted to User.`);
  });

  bot.command("setrole", async (ctx) => {
    if (!gate(ctx)) return;
    const p = parts("text" in ctx.message ? ctx.message.text : "");
    const id = Number(p[1]);
    const role = p[2] as Role | undefined;
    if (!Number.isFinite(id) || !role || !VALID_ROLES.includes(role))
      return safeReply(
        ctx,
        `Usage: /setrole <user_id> <${VALID_ROLES.join("|")}>`,
      );
    ensureUser(id);
    setRole(id, role);
    await syncCommandsForUser(bot, id, role);
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "setrole",
      meta: { target: id, role },
    });
    await safeReply(ctx, `User ${id} role set to ${ROLE_LABEL[role]}.`);
  });

  bot.command("killqueue", async (ctx) => {
    if (!gate(ctx)) return;
    const r = killQueue();
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "killqueue",
      meta: r,
    });
    await safeReply(ctx, `Queue killed. Dropped ${r.dropped} pending jobs.`);
  });

  bot.command("resetpipeline", async (ctx) => {
    if (!gate(ctx)) return;
    resetQueue();
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "resetpipeline",
      meta: {},
    });
    await safeReply(ctx, "Pipeline reset. Queue cleared.");
  });

  bot.command("debugmode", async (ctx) => {
    if (!gate(ctx)) return;
    const arg = parts("text" in ctx.message ? ctx.message.text : "")[1];
    if (arg !== "on" && arg !== "off")
      return safeReply(ctx, "Usage: /debugmode <on|off>");
    setDebug(arg === "on");
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "debugmode",
      meta: { value: arg },
    });
    await safeReply(ctx, `Debug mode: ${arg}.`);
  });

  bot.command("fullstats", async (ctx) => {
    if (!gate(ctx)) return;
    await safeReply(
      ctx,
      [analyticsSummary(), serverStats(), topUsersTable(5)].join("\n\n"),
    );
  });

  bot.command("systemhealth", async (ctx) => {
    if (!gate(ctx)) return;
    const q = queueStats();
    const dbCheck = (db.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    }).integrity_check;
    await safeReply(
      ctx,
      `System health\n` +
        `DB integrity: ${dbCheck}\n` +
        `Queue pending: ${q.pending}\n` +
        `Queue active: ${q.active}\n` +
        `Killed: ${q.killed}\n` +
        `Maintenance: ${state.maintenance}\n` +
        `Locked: ${state.locked}\n` +
        `Panic: ${state.panic}\n` +
        `Debug: ${state.debug}`,
    );
  });

  bot.command("audituser", async (ctx) => {
    if (!gate(ctx)) return;
    const id = Number(parts("text" in ctx.message ? ctx.message.text : "")[1]);
    if (!Number.isFinite(id))
      return safeReply(ctx, "Usage: /audituser <user_id>");
    const u = getUser(id);
    if (!u) return safeReply(ctx, "User not found.");
    const imgs = (db
      .prepare("SELECT COUNT(*) AS n FROM images WHERE user_id = ?")
      .get(id) as { n: number }).n;
    const credits = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM logs WHERE type = 'credit' AND user_id = ?`,
      )
      .get(id) as { n: number }).n;
    const last = db
      .prepare(
        "SELECT action, meta, timestamp FROM logs WHERE user_id = ? ORDER BY id DESC LIMIT 5",
      )
      .all(id) as { action: string; meta: string | null; timestamp: number }[];
    await safeReply(
      ctx,
      `Audit ${id}\n` +
        formatUserShort(u) +
        `\nImages: ${imgs}\n` +
        `Credit events: ${credits}\n\n` +
        `Recent activity:\n` +
        last
          .map(
            (l) =>
              `[${new Date(l.timestamp).toISOString().slice(11, 19)}] ${l.action}`,
          )
          .join("\n"),
    );
  });
}

function listBackups(): string {
  if (!fs.existsSync(BACKUP_DIR)) return "(none)";
  const files = fs.readdirSync(BACKUP_DIR).slice(-5);
  return files.length ? files.join("\n") : "(none)";
}

function formatUserShort(u: UserRow): string {
  return `Role: ${ROLE_LABEL[effectiveRole(u)]} · Plan: ${u.plan} · Credits: ${u.credits} · Banned: ${u.banned ? "yes" : "no"}`;
}
