import type { Telegraf } from "telegraf";
import { Markup } from "telegraf";
import type { BotContext } from "../middleware.js";
import { findModel } from "../models.js";
import {
  deductCredit,
  getBalance,
  InsufficientCreditsError,
  refundCredit,
} from "../credits.js";
import {
  DuplicateJobError,
  QueueFullError,
  submit,
  UserBusyError,
} from "../queue.js";
import { writeLog } from "../logs.js";
import {
  IMAGE_COST,
  BATCH_MAX_IMAGES,
  BATCH_TIMEOUT_MS,
  ETA_BATCH_TEXT,
} from "../config.js";
import { safeReply } from "../middleware.js";
import { logger } from "../logger.js";
import {
  StepReporter,
  buildModelKeyboard,
  isDuplicateForUser,
  processOneImage,
  type PendingImage,
} from "./photo.js";

type BatchStatus = "collecting" | "awaiting_model" | "processing";

interface BatchState {
  userId: number;
  entries: PendingImage[];
  startedAt: number;
  status: BatchStatus;
  timer: NodeJS.Timeout;
}

const batches = new Map<number, BatchState>();

function clearBatch(userId: number): BatchState | undefined {
  const b = batches.get(userId);
  if (!b) return undefined;
  clearTimeout(b.timer);
  batches.delete(userId);
  return b;
}

function armTimeout(state: BatchState, telegram: BotContext["telegram"]): void {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    const current = batches.get(state.userId);
    if (!current || current !== state) return;
    if (current.status === "processing") return;
    batches.delete(state.userId);
    telegram
      .sendMessage(
        state.userId,
        `Batch timed out after ${Math.round(BATCH_TIMEOUT_MS / 60000)} min of inactivity. No credits charged.`,
      )
      .catch(() => {});
  }, BATCH_TIMEOUT_MS);
  state.timer.unref?.();
}

/** True if the user currently has an open batch (collecting or awaiting model). */
export function isUserInBatch(userId: number): boolean {
  const b = batches.get(userId);
  if (!b) return false;
  return b.status === "collecting" || b.status === "awaiting_model";
}

export function registerBatchHandlers(bot: Telegraf<BotContext>) {
  bot.command("batch", async (ctx) => {
    const userId = ctx.from!.id;
    if (batches.has(userId)) {
      await safeReply(
        ctx,
        "You already have an open batch. Send images, then /done to finish — or wait for it to time out.",
      );
      return;
    }
    const balance = getBalance(userId);
    if (balance < 1) {
      await safeReply(
        ctx,
        `Not enough credits to start a batch. You have ${balance}.`,
      );
      return;
    }
    const state: BatchState = {
      userId,
      entries: [],
      startedAt: Date.now(),
      status: "collecting",
      timer: setTimeout(() => {}, 0),
    };
    batches.set(userId, state);
    armTimeout(state, ctx.telegram);
    await safeReply(
      ctx,
      `Batch started. Send up to ${BATCH_MAX_IMAGES} images, then /done.\n` +
        `Cost: ${IMAGE_COST} credit per image. ${ETA_BATCH_TEXT}.`,
    );
  });

  // Photo handler that runs FIRST and only handles input when a batch is open.
  // Falls through (calls next()) when there's no batch so the regular photo
  // flow in handlers/photo.ts takes over for single images.
  bot.on(["photo", "document"], async (ctx, next) => {
    const userId = ctx.from!.id;
    const state = batches.get(userId);
    if (!state || state.status !== "collecting") return next();

    let fileId: string | undefined;
    let fileUniqueId: string | undefined;
    let width = 0;
    let height = 0;

    if ("photo" in ctx.message && ctx.message.photo?.length) {
      const largest = ctx.message.photo[ctx.message.photo.length - 1];
      fileId = largest.file_id;
      fileUniqueId = largest.file_unique_id;
      width = largest.width;
      height = largest.height;
    } else if ("document" in ctx.message && ctx.message.document) {
      const doc = ctx.message.document;
      if (!doc.mime_type?.startsWith("image/")) {
        await safeReply(
          ctx,
          "Please send a photo or an image document (JPEG / PNG / HEIC).",
        );
        return;
      }
      fileId = doc.file_id;
      fileUniqueId = doc.file_unique_id;
    }

    if (!fileId || !fileUniqueId) {
      await safeReply(ctx, "Could not read that image. Send another, or /done.");
      return;
    }

    if (state.entries.length >= BATCH_MAX_IMAGES) {
      await safeReply(
        ctx,
        `Batch is full (${BATCH_MAX_IMAGES} images). Send /done to process.`,
      );
      return;
    }

    if (
      isDuplicateForUser(userId, fileUniqueId) ||
      state.entries.some((e) => e.fileUniqueId === fileUniqueId)
    ) {
      await safeReply(ctx, "Skipped: duplicate image (already in batch or history).");
      return;
    }

    state.entries.push({
      fileId,
      fileUniqueId,
      messageId: ctx.message.message_id,
      width,
      height,
      timestamp: Date.now(),
    });
    armTimeout(state, ctx.telegram);

    await safeReply(
      ctx,
      `Added (${state.entries.length}/${BATCH_MAX_IMAGES}). Send /done when ready.`,
    );
  });

  bot.command("done", async (ctx) => {
    const userId = ctx.from!.id;
    const state = batches.get(userId);
    if (!state) {
      await safeReply(ctx, "No active batch. Use /batch to start one.");
      return;
    }
    if (state.status !== "collecting") {
      await safeReply(ctx, "Batch already in progress.");
      return;
    }
    if (state.entries.length === 0) {
      clearBatch(userId);
      await safeReply(ctx, "Batch cancelled — no images were sent.");
      return;
    }
    state.status = "awaiting_model";
    armTimeout(state, ctx.telegram);
    const keyboard = buildModelKeyboard("batchmodel");
    await ctx.reply(
      `Pick the iPhone model for all ${state.entries.length} image(s).\n` +
        `Total cost: ${state.entries.length * IMAGE_COST} credits. ${ETA_BATCH_TEXT}.`,
      keyboard,
    );
  });

  bot.action(/^batchmodel:(.+)$/, async (ctx) => {
    const userId = ctx.from!.id;
    const modelKey = ctx.match[1];
    const meta = findModel(modelKey);
    if (!meta) {
      await ctx.answerCbQuery("Unknown model.");
      return;
    }
    const state = batches.get(userId);
    if (!state || state.status !== "awaiting_model") {
      await ctx.answerCbQuery("No batch awaiting model. Send /batch to start.");
      return;
    }
    state.status = "processing";
    clearTimeout(state.timer);
    await ctx.answerCbQuery(`Selected ${meta.label}`);

    const total = state.entries.length;
    const cost = total * IMAGE_COST;

    // Reserve all credits up front so a mid-batch insufficient-balance error
    // can't half-process the batch. Refund unused credits at the end.
    let reserved = 0;
    try {
      deductCredit(userId, cost, "batch_reserve");
      reserved = cost;
    } catch (err) {
      batches.delete(userId);
      if (err instanceof InsufficientCreditsError) {
        await safeReply(
          ctx,
          `Not enough credits. You have ${err.available}, need ${cost}.`,
        );
        return;
      }
      throw err;
    }

    let succeeded = 0;
    let failed = 0;
    const reporter = new StepReporter(ctx.telegram, ctx.chat!.id);
    await reporter.start(`Batch starting: 0/${total}…`);

    for (let i = 0; i < state.entries.length; i++) {
      const pending = state.entries[i];
      const idx = i + 1;
      const jobKey = `img:${userId}:${pending.fileUniqueId}:${meta.key}`;

      try {
        await reporter.update(`Image ${idx}/${total} — processing…`);
        await submit({ userId, jobKey }, async (jc) => {
          // Skip the per-image StepReporter — the batch reporter already shows
          // overall progress; nesting two would cause edit-rate-limit churn.
          await processOneImage(
            ctx,
            pending,
            meta,
            jc.signal,
            undefined,
            `Batch ${idx}/${total}`,
          );
        });
        succeeded += 1;
      } catch (err) {
        failed += 1;
        // Refund this single image's credit out of the reservation pool.
        if (reserved >= IMAGE_COST) {
          refundCredit(userId, IMAGE_COST, "batch_image_failed");
          reserved -= IMAGE_COST;
        }
        const reason =
          err instanceof QueueFullError
            ? "queue full"
            : err instanceof UserBusyError
              ? "busy"
              : err instanceof DuplicateJobError
                ? "duplicate"
                : ((err as Error)?.message ?? "error");
        logger.warn({ err, userId, idx }, "batch image failed");
        writeLog({
          type: "error",
          userId,
          action: "batch_image",
          meta: { idx, model: meta.label, reason },
        });
        await safeReply(ctx, `Image ${idx}/${total} failed: ${reason}. Credit refunded.`);
      }
    }

    batches.delete(userId);

    const summary =
      `Batch done.\n` +
      `Processed: ${succeeded}/${total}\n` +
      `Failed: ${failed}\n` +
      `Credits used: ${reserved === 0 ? cost : cost - reserved}/${cost}\n` +
      `Balance: ${getBalance(userId)}`;
    await reporter.finish(summary);
  });
}
