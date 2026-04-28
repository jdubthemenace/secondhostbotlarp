import type { Telegraf } from "telegraf";
import type { BotContext } from "../middleware.js";
import { db, nowMs } from "../db.js";
import { effectiveRole, ROLE_LABEL, getUser } from "../roles.js";
import { getBalance } from "../credits.js";
import { IPHONE_MODELS } from "../models.js";
import { writeLog } from "../logs.js";
import { SUPPORT_CONTACT, IMAGE_COST } from "../config.js";
import { safeReply } from "../middleware.js";
import { helpForRole } from "../command_menu.js";

const PLAN_DETAILS = `<b>Plans</b>
• <b>Free</b> — daily use, standard queue
• <b>Pro</b> — priority queue, more credits
• <b>VIP</b> — top priority, highest credits

Contact ${SUPPORT_CONTACT} to upgrade.`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function registerUserCommands(bot: Telegraf<BotContext>) {
  bot.start(async (ctx) => {
    const user = ctx.appUser;
    const role = effectiveRole(user);
    const name = escapeHtml(user.first_name ?? "friend");

    const text =
      `📸 <b>iMetaLens</b>\n` +
      `<i>Realistic iPhone EXIF metadata, on demand.</i>\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `👋 Welcome, <b>${name}</b>\n` +
      `🎖 Rank: <b>${ROLE_LABEL[role]}</b>\n` +
      `💎 Credits: <b>${user.credits}</b>   ·   ` +
      `🧾 Cost: <b>${IMAGE_COST}/image</b>\n\n` +
      `<b>How it works</b>\n` +
      `1. Send a photo (or image file)\n` +
      `2. Pick an iPhone model\n` +
      `3. Receive a 9:16 file with realistic EXIF\n\n` +
      `<b>Quick commands</b>\n` +
      `• /help — your full command list\n` +
      `• /credits — check balance\n` +
      `• /models — supported iPhones\n` +
      `• /plan — upgrade options\n` +
      `• /stats — your activity\n` +
      `• /history — last 10 images\n` +
      `• /referral — invite link\n` +
      `• /feedback — send us a note\n\n` +
      `🛟 Support: ${SUPPORT_CONTACT}`;

    await ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.command("help", async (ctx) => {
    const role = effectiveRole(ctx.appUser);
    const text = helpForRole(role);
    await ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.command("credits", async (ctx) => {
    const balance = getBalance(ctx.from!.id);
    await safeReply(
      ctx,
      `You have ${balance} credit${balance === 1 ? "" : "s"}.\nEach image costs ${IMAGE_COST}.`,
    );
  });

  bot.command("models", async (ctx) => {
    const list = IPHONE_MODELS.map(
      (m) => `• ${m.label} — ${m.megapixels} MP`,
    ).join("\n");
    await safeReply(ctx, `Supported iPhone models:\n${list}`);
  });

  bot.command("plan", async (ctx) => {
    const u = getUser(ctx.from!.id);
    await ctx.reply(
      `Your plan: <b>${escapeHtml(u?.plan ?? "free")}</b>\n\n${PLAN_DETAILS}`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("stats", async (ctx) => {
    const u = ctx.appUser;
    const total = (
      db
        .prepare("SELECT COUNT(*) AS n FROM images WHERE user_id = ?")
        .get(u.user_id) as { n: number }
    ).n;
    await safeReply(
      ctx,
      `Your stats\n\n` +
        `Role: ${ROLE_LABEL[effectiveRole(u)]}\n` +
        `Plan: ${u.plan}\n` +
        `Credits: ${u.credits}\n` +
        `Images processed: ${total}`,
    );
  });

  bot.command("history", async (ctx) => {
    const rows = db
      .prepare(
        "SELECT model, created_at FROM images WHERE user_id = ? ORDER BY id DESC LIMIT 10",
      )
      .all(ctx.from!.id) as { model: string; created_at: number }[];
    if (!rows.length) {
      await safeReply(ctx, "No history yet. Send a photo to get started.");
      return;
    }
    const text = rows
      .map((r, i) => {
        const d = new Date(r.created_at).toISOString().replace("T", " ").slice(0, 19);
        return `${i + 1}. ${r.model} — ${d}`;
      })
      .join("\n");
    await safeReply(ctx, `Last 10 images:\n${text}`);
  });

  bot.command("referral", async (ctx) => {
    const me = await ctx.telegram.getMe();
    const link = `https://t.me/${me.username}?start=ref_${ctx.from!.id}`;
    await safeReply(
      ctx,
      `Share this link with friends:\n${link}\n\nWhen they use the bot, you both get bonus credits soon.`,
    );
  });

  bot.command("feedback", async (ctx) => {
    const text =
      ctx.message && "text" in ctx.message
        ? ctx.message.text.replace(/^\/feedback(@\S+)?\s*/, "").trim()
        : "";
    if (!text) {
      await safeReply(ctx, "Usage: /feedback <your message>");
      return;
    }
    db.prepare(
      "INSERT INTO feedback(user_id, message, timestamp) VALUES(?, ?, ?)",
    ).run(ctx.from!.id, text, nowMs());
    writeLog({
      type: "system",
      userId: ctx.from!.id,
      action: "feedback",
      meta: { length: text.length },
    });
    await safeReply(ctx, `Thanks! Feedback received.\nSupport: ${SUPPORT_CONTACT}`);
  });
}
