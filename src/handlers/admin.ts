import type { Telegraf } from "telegraf";
import type { BotContext } from "../middleware.js";
import { db } from "../db.js";
import {
  ROLE_LABEL,
  effectiveRole,
  ensureUser,
  getUser,
  hasRoleAtLeast,
  setPlan,
} from "../roles.js";
import {
  addCredits,
  setCredits as setCreditsFn,
  takeCredits,
} from "../credits.js";
import { writeLog, clearLogs } from "../logs.js";
import { safeReply } from "../middleware.js";
import { analyticsSummary, serverStats, topUsersTable } from "../analytics.js";
import { isInflight } from "../queue.js";

function gate(role: Parameters<typeof hasRoleAtLeast>[1]) {
  return (ctx: BotContext) => hasRoleAtLeast(ctx.appUser, role);
}

function parts(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Mask a numeric user id for staff-facing listings: 1234567890 -> 12******90. */
function maskUserId(id: number): string {
  const s = String(id);
  if (s.length <= 4) return s;
  return `${s.slice(0, 2)}${"*".repeat(s.length - 4)}${s.slice(-2)}`;
}

/** job_key format used by the photo pipeline: img:<userId>:<fileUnique>:<modelKey>. */
function parseModelFromJobKey(key: string): string {
  const parts = key.split(":");
  return parts[3] ?? "—";
}

export function registerAdminCommands(bot: Telegraf<BotContext>) {
  bot.command("setcredits", async (ctx) => {
    if (!gate("admin")(ctx)) return;
    const p = parts("text" in ctx.message ? ctx.message.text : "");
    const id = Number(p[1]);
    const value = Number(p[2]);
    if (!Number.isFinite(id) || !Number.isFinite(value))
      return safeReply(ctx, "Usage: /setcredits <user_id> <amount>");
    setCreditsFn(id, value);
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "setcredits",
      meta: { target: id, value },
    });
    await safeReply(ctx, `Credits for ${id} set to ${value}.`);
  });

  bot.command("addcredits", async (ctx) => {
    if (!gate("admin")(ctx)) return;
    const p = parts("text" in ctx.message ? ctx.message.text : "");
    const id = Number(p[1]);
    const value = Number(p[2]);
    if (!Number.isFinite(id) || !Number.isFinite(value))
      return safeReply(ctx, "Usage: /addcredits <user_id> <amount>");
    const after = addCredits(id, value);
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "addcredits",
      meta: { target: id, amount: value, after },
    });
    await safeReply(ctx, `Added ${value} to ${id}. New balance: ${after}.`);
  });

  bot.command("takecredits", async (ctx) => {
    if (!gate("admin")(ctx)) return;
    const p = parts("text" in ctx.message ? ctx.message.text : "");
    const id = Number(p[1]);
    const value = Number(p[2]);
    if (!Number.isFinite(id) || !Number.isFinite(value))
      return safeReply(ctx, "Usage: /takecredits <user_id> <amount>");
    const after = takeCredits(id, value);
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "takecredits",
      meta: { target: id, amount: value, after },
    });
    await safeReply(ctx, `Took up to ${value} from ${id}. New balance: ${after}.`);
  });

  bot.command("setplan", async (ctx) => {
    if (!gate("admin")(ctx)) return;
    const p = parts("text" in ctx.message ? ctx.message.text : "");
    const id = Number(p[1]);
    const plan = p[2] as "free" | "pro" | "vip" | undefined;
    if (!Number.isFinite(id) || !plan || !["free", "pro", "vip"].includes(plan))
      return safeReply(ctx, "Usage: /setplan <user_id> <free|pro|vip>");
    ensureUser(id);
    setPlan(id, plan);
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "setplan",
      meta: { target: id, plan },
    });
    await safeReply(ctx, `Plan for ${id} set to ${plan}.`);
  });

  bot.command("userlist", async (ctx) => {
    if (!gate("admin")(ctx)) return;
    const rows = db
      .prepare(
        "SELECT user_id, username, role, plan, credits, banned FROM users ORDER BY created_at DESC LIMIT 25",
      )
      .all() as Array<{
      user_id: number;
      username: string | null;
      role: string;
      plan: string;
      credits: number;
      banned: number;
    }>;
    if (!rows.length) return safeReply(ctx, "No users.");
    const text = rows
      .map(
        (r) =>
          `${r.user_id} @${r.username ?? "—"} ${r.role}${r.banned ? "⛔" : ""} ${r.plan} ${r.credits}c`,
      )
      .join("\n");
    await safeReply(ctx, `Recent users (25):\n${text}`);
  });

  bot.command("analytics", async (ctx) => {
    if (!gate("admin")(ctx)) return;
    await safeReply(ctx, analyticsSummary());
  });

  bot.command("serverstats", async (ctx) => {
    if (!gate("admin")(ctx)) return;
    await safeReply(ctx, serverStats());
  });

  bot.command("topusers", async (ctx) => {
    if (!gate("admin")(ctx)) return;
    await safeReply(ctx, topUsersTable());
  });

  bot.command("broadcast", async (ctx) => {
    if (!gate("admin")(ctx)) return;
    const text = "text" in ctx.message ? ctx.message.text : "";
    const message = text.replace(/^\/broadcast(@\S+)?\s*/, "").trim();
    if (!message) return safeReply(ctx, "Usage: /broadcast <message>");
    const targets = db
      .prepare("SELECT user_id FROM users WHERE banned = 0")
      .all() as { user_id: number }[];
    let ok = 0;
    let fail = 0;
    for (const t of targets) {
      try {
        await ctx.telegram.sendMessage(t.user_id, message);
        ok++;
      } catch {
        fail++;
      }
    }
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "broadcast",
      meta: { ok, fail, length: message.length },
    });
    await safeReply(ctx, `Broadcast: sent ${ok}, failed ${fail}.`);
  });

  bot.command("clearlogs", async (ctx) => {
    if (!gate("admin")(ctx)) return;
    const n = clearLogs();
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "clearlogs",
      meta: { removed: n },
    });
    await safeReply(ctx, `Cleared ${n} log rows.`);
  });

  bot.command("jobs", async (ctx) => {
    if (!gate("superadmin")(ctx)) return;
    const rows = db
      .prepare(
        `SELECT job_key, user_id, timestamp
           FROM processed_jobs
          ORDER BY timestamp DESC
          LIMIT 25`,
      )
      .all() as { job_key: string; user_id: number; timestamp: number }[];
    if (!rows.length) {
      await safeReply(ctx, "No processed jobs yet.");
      return;
    }
    const lines = rows.map((r) => {
      const masked = maskUserId(r.user_id);
      const model = parseModelFromJobKey(r.job_key);
      const status = isInflight(r.job_key) ? "inflight" : "done";
      const ts = new Date(r.timestamp)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
      return `${ts}  ${masked}  ${model}  ${status}`;
    });
    await safeReply(
      ctx,
      `Recent jobs (${rows.length}):\n` +
        `time                 user        model    status\n` +
        lines.join("\n"),
    );
  });

  bot.command("clearfeedback", async (ctx) => {
    if (!gate("admin")(ctx)) return;
    const info = db.prepare("DELETE FROM feedback").run();
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "clearfeedback",
      meta: { removed: info.changes },
    });
    await safeReply(ctx, `Cleared ${info.changes} feedback rows.`);
  });
}

export { ROLE_LABEL, effectiveRole, getUser };
