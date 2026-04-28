import type { Telegraf } from "telegraf";
import type { BotContext } from "../middleware.js";
import { db } from "../db.js";
import {
  ROLE_LABEL,
  effectiveRole,
  getUser,
  hasRoleAtLeast,
  setBan,
  type UserRow,
} from "../roles.js";
import { writeLog, recentLogs } from "../logs.js";
import { safeReply } from "../middleware.js";
import { topModelsTable } from "../analytics.js";

function gate(role: Parameters<typeof hasRoleAtLeast>[1]) {
  return (ctx: BotContext) => hasRoleAtLeast(ctx.appUser, role);
}

function parseUserId(text: string | undefined): number | null {
  if (!text) return null;
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const id = Number(parts[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function tail(text: string): string {
  const idx = text.indexOf(" ");
  return idx === -1 ? "" : text.slice(idx + 1).trim();
}

function tailAfter(text: string, parts: number): string {
  const split = text.split(/\s+/);
  return split.slice(parts + 1).join(" ").trim();
}

export function registerModeratorCommands(bot: Telegraf<BotContext>) {
  bot.command("userinfo", async (ctx) => {
    if (!gate("moderator")(ctx)) return;
    const id = parseUserId("text" in ctx.message ? ctx.message.text : "");
    if (!id) return safeReply(ctx, "Usage: /userinfo <user_id>");
    const u = getUser(id);
    if (!u) return safeReply(ctx, "User not found.");
    await safeReply(ctx, formatUser(u));
  });

  bot.command("searchuser", async (ctx) => {
    if (!gate("moderator")(ctx)) return;
    const term = tail("text" in ctx.message ? ctx.message.text : "");
    if (!term) return safeReply(ctx, "Usage: /searchuser <username|id>");
    let rows: UserRow[];
    if (/^\d+$/.test(term)) {
      rows = db
        .prepare("SELECT * FROM users WHERE user_id = ? LIMIT 10")
        .all(Number(term)) as UserRow[];
    } else {
      const like = `%${term.replace(/^@/, "")}%`;
      rows = db
        .prepare(
          "SELECT * FROM users WHERE username LIKE ? OR first_name LIKE ? LIMIT 10",
        )
        .all(like, like) as UserRow[];
    }
    if (!rows.length) return safeReply(ctx, "No matches.");
    const out = rows
      .map(
        (r) =>
          `${r.user_id} · @${r.username ?? "—"} · ${ROLE_LABEL[effectiveRole(r)]} · ${r.credits}c`,
      )
      .join("\n");
    await safeReply(ctx, out);
  });

  bot.command("userhistory", async (ctx) => {
    if (!gate("moderator")(ctx)) return;
    const id = parseUserId("text" in ctx.message ? ctx.message.text : "");
    if (!id) return safeReply(ctx, "Usage: /userhistory <user_id>");
    const rows = db
      .prepare(
        "SELECT model, created_at FROM images WHERE user_id = ? ORDER BY id DESC LIMIT 15",
      )
      .all(id) as { model: string; created_at: number }[];
    if (!rows.length) return safeReply(ctx, "No images for that user.");
    await safeReply(
      ctx,
      rows
        .map(
          (r, i) =>
            `${i + 1}. ${r.model} — ${new Date(r.created_at).toISOString().slice(0, 19)}`,
        )
        .join("\n"),
    );
  });

  bot.command("ban", async (ctx) => {
    if (!gate("moderator")(ctx)) return;
    const id = parseUserId("text" in ctx.message ? ctx.message.text : "");
    if (!id) return safeReply(ctx, "Usage: /ban <user_id>");
    const target = getUser(id);
    if (!target) return safeReply(ctx, "User not found.");
    if (!canActOn(ctx, target))
      return safeReply(ctx, "Cannot act on a user with equal or higher rank.");
    if (!setBan(id, true))
      return safeReply(ctx, "Cannot ban this user.");
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "ban",
      meta: { target: id },
    });
    await safeReply(ctx, `User ${id} banned.`);
  });

  bot.command("unban", async (ctx) => {
    if (!gate("moderator")(ctx)) return;
    const id = parseUserId("text" in ctx.message ? ctx.message.text : "");
    if (!id) return safeReply(ctx, "Usage: /unban <user_id>");
    if (!setBan(id, false))
      return safeReply(ctx, "Cannot unban this user.");
    writeLog({
      type: "admin",
      userId: ctx.from!.id,
      action: "unban",
      meta: { target: id },
    });
    await safeReply(ctx, `User ${id} unbanned.`);
  });

  bot.command("topmodels", async (ctx) => {
    if (!gate("moderator")(ctx)) return;
    await safeReply(ctx, topModelsTable());
  });

  bot.command("logs", async (ctx) => {
    if (!gate("moderator")(ctx)) return;
    const rows = recentLogs(20) as Array<{
      type: string;
      user_id: number | null;
      action: string;
      timestamp: number;
    }>;
    if (!rows.length) return safeReply(ctx, "No logs yet.");
    await safeReply(
      ctx,
      rows
        .map(
          (r) =>
            `[${new Date(r.timestamp).toISOString().slice(11, 19)}] ${r.type} u:${r.user_id ?? "-"} ${r.action}`,
        )
        .join("\n"),
    );
  });

  bot.command("feedbacks", async (ctx) => {
    if (!gate("moderator")(ctx)) return;
    const rows = db
      .prepare(
        "SELECT user_id, message, timestamp FROM feedback ORDER BY id DESC LIMIT 10",
      )
      .all() as { user_id: number; message: string; timestamp: number }[];
    if (!rows.length) return safeReply(ctx, "No feedback.");
    await safeReply(
      ctx,
      rows
        .map(
          (r) =>
            `[${new Date(r.timestamp).toISOString().slice(0, 19)}] ${r.user_id}: ${r.message.slice(0, 200)}`,
        )
        .join("\n\n"),
    );
  });

  bot.command("dm", async (ctx) => {
    if (!gate("moderator")(ctx)) return;
    const text = "text" in ctx.message ? ctx.message.text : "";
    const id = parseUserId(text);
    const message = tailAfter(text, 1);
    if (!id || !message) return safeReply(ctx, "Usage: /dm <user_id> <message>");
    try {
      await ctx.telegram.sendMessage(id, message);
      writeLog({
        type: "admin",
        userId: ctx.from!.id,
        action: "dm",
        meta: { target: id, length: message.length },
      });
      await safeReply(ctx, "Sent.");
    } catch (err) {
      await safeReply(ctx, `Failed: ${(err as Error).message}`);
    }
  });
}

export function canActOn(ctx: BotContext, target: UserRow): boolean {
  const actorRole = effectiveRole(ctx.appUser);
  const targetRole = effectiveRole(target);
  if (actorRole === "founder") return true;
  const rank: Record<string, number> = {
    banned: -1,
    user: 0,
    moderator: 1,
    admin: 2,
    superadmin: 3,
    cofounder: 4,
    founder: 5,
  };
  return rank[actorRole] > rank[targetRole];
}

export function formatUser(u: UserRow): string {
  const role = ROLE_LABEL[effectiveRole(u)];
  return (
    `User ${u.user_id}\n` +
    `Username: @${u.username ?? "—"}\n` +
    `Name: ${u.first_name ?? "—"}\n` +
    `Role: ${role}\n` +
    `Plan: ${u.plan}\n` +
    `Credits: ${u.credits}\n` +
    `Banned: ${u.banned ? "yes" : "no"}\n` +
    `Joined: ${new Date(u.created_at).toISOString().slice(0, 19)}`
  );
}
