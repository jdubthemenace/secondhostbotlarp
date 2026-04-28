import type { Context, MiddlewareFn } from "telegraf";
import { ensureUser, effectiveRole, ROLE_LABEL } from "./roles.js";
import { state } from "./state.js";
import { writeLog } from "./logs.js";
import { logger } from "./logger.js";
import { FOUNDER_ID, SUPPORT_CONTACT } from "./config.js";

export interface BotContext extends Context {
  appUser: ReturnType<typeof ensureUser>;
  startedAt: number;
}

const buckets = new Map<number, { count: number; resetAt: number }>();

function rateLimited(userId: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(userId);
  const limit = state.rateLimitPerMin;
  if (!bucket || bucket.resetAt < now) {
    buckets.set(userId, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > limit;
}

export const globalMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  ctx.startedAt = Date.now();

  const from = ctx.from;
  if (!from || from.is_bot) return;

  // 1. authentication / ensure user
  const appUser = ensureUser(from.id, from.username, from.first_name);
  ctx.appUser = appUser;

  const role = effectiveRole(appUser);
  const messageText =
    ctx.message && "text" in ctx.message ? ctx.message.text : undefined;
  const isCommand = messageText?.startsWith("/") ?? false;

  // 2. ban check
  if (role === "banned") {
    if (isCommand) {
      await safeReply(
        ctx,
        `You are banned from using this bot.\nContact ${SUPPORT_CONTACT} for support.`,
      );
    }
    return;
  }

  // 3. global lock & maintenance (founder always passes)
  if (from.id !== FOUNDER_ID) {
    if (state.panic) {
      if (isCommand)
        await safeReply(ctx, "Bot is in panic mode. Please try again later.");
      return;
    }
    if (state.locked) {
      if (isCommand)
        await safeReply(ctx, "Bot is currently locked. Please try again later.");
      return;
    }
    if (state.maintenance) {
      if (isCommand)
        await safeReply(
          ctx,
          "Bot is under maintenance. Please try again shortly.",
        );
      return;
    }
  }

  // 4. rate limit
  if (rateLimited(from.id)) {
    if (isCommand) await safeReply(ctx, "Slow down. Please wait a moment.");
    return;
  }

  // 5. execution
  try {
    await next();
  } catch (err) {
    logger.error({ err, userId: from.id }, "handler error");
    writeLog({
      type: "error",
      userId: from.id,
      action: "handler_error",
      meta: { message: (err as Error)?.message },
    });
    if (state.debug) {
      await safeReply(
        ctx,
        `Error: ${(err as Error)?.message ?? "unknown"}`,
      );
    } else {
      await safeReply(ctx, "Something went wrong. Please try again.");
    }
  } finally {
    // 6. logging
    writeLog({
      type: "system",
      userId: from.id,
      action: isCommand ? "command" : "update",
      meta: {
        text: messageText?.slice(0, 200),
        role: ROLE_LABEL[role],
        durationMs: Date.now() - ctx.startedAt,
      },
    });
  }
};

export async function safeReply(ctx: Context, text: string, extra?: object) {
  try {
    await ctx.reply(text, extra as never);
  } catch (err) {
    logger.warn({ err }, "failed to reply");
  }
}
