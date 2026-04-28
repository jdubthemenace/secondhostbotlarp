import type { Telegraf } from "telegraf";
import type { BotContext } from "../middleware.js";
import { db, nowMs } from "../db.js";
import {
  ROLE_LABEL,
  ensureUser,
  effectiveRole,
  getUser,
  hasRoleAtLeast,
} from "../roles.js";
import { addCredits } from "../credits.js";
import { writeLog } from "../logs.js";
import { setLocked, setMaintenance, setRateLimit, state } from "../state.js";
import { safeReply } from "../middleware.js";
import { STARTING_CREDITS } from "../config.js";

function gate(ctx: BotContext) {
  return hasRoleAtLeast(ctx.appUser, "cofounder");
}

function parts(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function registerCofounderCommands(bot: Telegraf<BotContext>) {
  bot.command("resetuser", async (ctx) => {
    if (!gate(ctx)) return;
    const id = Number(parts("text" in ctx.message ? ctx.message.text : "")[1]);
    if (!Number.isFinite(id)) return safeReply(ctx, "Usage: /resetuser <user_id>");
    const target = getUser(id);
    if (!target) return safeReply(ctx, "User not found.");
    if (target.role === "founder") return safeReply(ctx, "Cannot reset founder.");
    db.prepare(
      `UPDATE users SET credits = ?, plan = 'free', banned = 0, role = CASE WHEN role IN ('user','banned') THEN 'user' ELSE role END, updated_at = ? WHERE user_id = ?`,
    ).run(STARTING_CREDITS, nowMs(), id);
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "resetuser",
      meta: { target: id },
    });
    await safeReply(ctx, `User ${id} reset.`);
  });

  bot.command("banlist", async (ctx) => {
    if (!gate(ctx)) return;
    const rows = db
      .prepare(
        "SELECT user_id, username FROM users WHERE banned = 1 ORDER BY updated_at DESC LIMIT 50",
      )
      .all() as { user_id: number; username: string | null }[];
    if (!rows.length) return safeReply(ctx, "No banned users.");
    await safeReply(
      ctx,
      "Banned users:\n" +
        rows.map((r) => `${r.user_id} @${r.username ?? "—"}`).join("\n"),
    );
  });

  bot.command("activeusers", async (ctx) => {
    if (!gate(ctx)) return;
    const since = Date.now() - 24 * 3600 * 1000;
    const rows = db
      .prepare(
        `SELECT u.user_id, u.username, COUNT(i.id) AS n
           FROM users u
           LEFT JOIN images i ON i.user_id = u.user_id AND i.created_at > ?
          GROUP BY u.user_id
          HAVING n > 0
          ORDER BY n DESC
          LIMIT 25`,
      )
      .all(since) as { user_id: number; username: string | null; n: number }[];
    if (!rows.length) return safeReply(ctx, "No active users in last 24h.");
    await safeReply(
      ctx,
      "Active 24h:\n" +
        rows.map((r) => `${r.user_id} @${r.username ?? "—"} — ${r.n}`).join("\n"),
    );
  });

  bot.command("maintenance", async (ctx) => {
    if (!gate(ctx)) return;
    const arg = parts("text" in ctx.message ? ctx.message.text : "")[1];
    if (arg !== "on" && arg !== "off")
      return safeReply(ctx, "Usage: /maintenance <on|off>");
    setMaintenance(arg === "on");
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "maintenance",
      meta: { value: arg },
    });
    await safeReply(ctx, `Maintenance mode: ${arg}.`);
  });

  bot.command("lockbot", async (ctx) => {
    if (!gate(ctx)) return;
    setLocked(true);
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "lockbot",
      meta: {},
    });
    await safeReply(ctx, "Bot locked.");
  });

  bot.command("unlockbot", async (ctx) => {
    if (!gate(ctx)) return;
    setLocked(false);
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "unlockbot",
      meta: {},
    });
    await safeReply(ctx, "Bot unlocked.");
  });

  bot.command("ratelimit", async (ctx) => {
    if (!gate(ctx)) return;
    const v = Number(parts("text" in ctx.message ? ctx.message.text : "")[1]);
    if (!Number.isFinite(v) || v <= 0)
      return safeReply(
        ctx,
        `Usage: /ratelimit <per-minute>\nCurrent: ${state.rateLimitPerMin}`,
      );
    setRateLimit(v);
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "ratelimit",
      meta: { value: state.rateLimitPerMin },
    });
    await safeReply(ctx, `Rate limit set to ${state.rateLimitPerMin}/min.`);
  });

  bot.command("giveall", async (ctx) => {
    if (!gate(ctx)) return;
    const v = Number(parts("text" in ctx.message ? ctx.message.text : "")[1]);
    if (!Number.isFinite(v) || v <= 0)
      return safeReply(ctx, "Usage: /giveall <amount>");
    const targets = db
      .prepare("SELECT user_id FROM users WHERE banned = 0")
      .all() as { user_id: number }[];
    for (const t of targets) addCredits(t.user_id, v);
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "giveall",
      meta: { amount: v, count: targets.length },
    });
    await safeReply(ctx, `Granted ${v} credits to ${targets.length} users.`);
  });
}

void ROLE_LABEL;
void effectiveRole;
void ensureUser;
