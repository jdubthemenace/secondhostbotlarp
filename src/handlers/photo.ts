import type { Telegraf } from "telegraf";
import { Markup } from "telegraf";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { BotContext } from "../middleware.js";
import { findModel, IPHONE_MODELS } from "../models.js";
import { injectIPhoneExif } from "../exif.js";
import {
  analyzeBrightness,
  encodeAsHeic,
  pickRealisticExposure,
  pickSuggestedModel,
  resizeToAppleSensor,
} from "../image.js";
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
import { db, nowMs } from "../db.js";
import { writeLog } from "../logs.js";
import {
  TMP_DIR,
  IMAGE_COST,
  MAX_IMAGE_BYTES,
  ETA_SINGLE_TEXT,
} from "../config.js";
import { safeReply } from "../middleware.js";
import { logger } from "../logger.js";
import { isUserInBatch } from "./batch.js";

export interface PendingImage {
  fileId: string;
  fileUniqueId: string;
  messageId: number;
  width: number;
  height: number;
  timestamp: number;
}

const pendingByUser = new Map<number, PendingImage>();

/**
 * Reusable inline status message — sends one Telegram message and edits its
 * text on each step so the chat doesn't fill up with progress spam. All edits
 * are best-effort: a failed edit (rate limit, message deleted, etc.) is
 * swallowed so the underlying pipeline keeps going.
 */
export class StepReporter {
  private chatId: number;
  private messageId: number | undefined;
  private telegram: BotContext["telegram"];

  constructor(telegram: BotContext["telegram"], chatId: number) {
    this.telegram = telegram;
    this.chatId = chatId;
  }

  async start(text: string): Promise<void> {
    try {
      const msg = await this.telegram.sendMessage(this.chatId, text);
      this.messageId = msg.message_id;
    } catch {
      /* best effort */
    }
  }

  async update(text: string): Promise<void> {
    if (!this.messageId) return;
    try {
      await this.telegram.editMessageText(
        this.chatId,
        this.messageId,
        undefined,
        text,
      );
    } catch {
      /* best effort */
    }
  }

  async finish(text: string): Promise<void> {
    await this.update(text);
  }
}

/** True if this user already has a successfully processed image with the same content hash. */
export function isDuplicateForUser(
  userId: number,
  fileUniqueId: string,
): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS found FROM images WHERE user_id = ? AND file_unique = ? LIMIT 1",
    )
    .get(userId, fileUniqueId) as { found: number } | undefined;
  return !!row;
}

export function registerPhotoHandlers(bot: Telegraf<BotContext>) {
  bot.on(["photo", "document"], async (ctx) => {
    const userId = ctx.from!.id;

    // /batch flow owns photo handling for this user — its handler runs first
    // and stops propagation, but guard here too so we never double-handle if
    // registration order is ever changed.
    if (isUserInBatch(userId)) return;

    let fileId: string | undefined;
    let fileUniqueId: string | undefined;
    let width = 0;
    let height = 0;
    let mimeType: string | undefined;
    let thumbFileId: string | undefined;

    if ("photo" in ctx.message && ctx.message.photo?.length) {
      const sizes = ctx.message.photo;
      const largest = sizes[sizes.length - 1];
      fileId = largest.file_id;
      fileUniqueId = largest.file_unique_id;
      width = largest.width;
      height = largest.height;
      thumbFileId = sizes[0].file_id;
    } else if ("document" in ctx.message && ctx.message.document) {
      const doc = ctx.message.document;
      mimeType = doc.mime_type;
      if (!mimeType?.startsWith("image/")) {
        await safeReply(
          ctx,
          "Please send a photo or an image document (JPEG / PNG / HEIC).",
        );
        return;
      }
      fileId = doc.file_id;
      fileUniqueId = doc.file_unique_id;
      thumbFileId = doc.thumbnail?.file_id;
    }

    if (!fileId || !fileUniqueId) {
      await safeReply(ctx, "Could not read the image. Please try again.");
      return;
    }

    // Duplicate detection (per-user). Telegram's `file_unique_id` is a stable
    // content-based identifier, so re-uploading the exact same image surfaces
    // the same id. Block before any credit deduction.
    if (isDuplicateForUser(userId, fileUniqueId)) {
      await safeReply(
        ctx,
        "You've already processed this exact image. No credit was charged.",
      );
      return;
    }

    pendingByUser.set(userId, {
      fileId,
      fileUniqueId,
      messageId: ctx.message.message_id,
      width,
      height,
      timestamp: Date.now(),
    });

    const keyboard = buildModelKeyboard("model");
    const baseText =
      `Image received. Choose iPhone model to inject EXIF (cost: ${IMAGE_COST} credit).\n` +
      `${ETA_SINGLE_TEXT}`;

    let sent: { chat: { id: number }; message_id: number } | undefined;
    try {
      sent = await ctx.reply(baseText, keyboard);
    } catch {
      /* swallow — fall through, user will resend */
    }

    // Background suggestion: download the smallest available variant, measure
    // brightness, and edit the picker message to highlight a recommended model.
    // Best-effort and time-bounded so a slow/failed CDN never blocks the user.
    if (sent && thumbFileId) {
      void suggestModelInBackground(
        ctx,
        thumbFileId,
        sent.chat.id,
        sent.message_id,
        baseText,
        keyboard,
      );
    }
  });

  bot.action(/^model:(.+)$/, async (ctx) => {
    const userId = ctx.from!.id;
    const modelKey = ctx.match[1];
    const meta = findModel(modelKey);
    if (!meta) {
      await ctx.answerCbQuery("Unknown model.");
      return;
    }
    const pending = pendingByUser.get(userId);
    if (!pending) {
      await ctx.answerCbQuery("No image pending. Please send a photo first.");
      return;
    }
    pendingByUser.delete(userId);
    await ctx.answerCbQuery(`Selected ${meta.label}`);

    // Re-check duplicate at processing time too (defense in depth — covers the
    // race where a user picks a model on stale buttons after another job for
    // the same file completed).
    if (isDuplicateForUser(userId, pending.fileUniqueId)) {
      await safeReply(
        ctx,
        "This image was already processed. No credit was charged.",
      );
      return;
    }

    const jobKey = `img:${userId}:${pending.fileUniqueId}:${meta.key}`;

    let deducted = false;
    const reporter = new StepReporter(ctx.telegram, ctx.chat!.id);
    try {
      try {
        deductCredit(userId, IMAGE_COST, "image_exif");
        deducted = true;
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          await ctx.reply(
            `Not enough credits. You have ${err.available}, need ${IMAGE_COST}.`,
          );
          return;
        }
        throw err;
      }

      try {
        await submit({ userId, jobKey }, async (jc) => {
          await processOneImage(ctx, pending, meta, jc.signal, reporter);
        });
      } catch (err) {
        if (err instanceof QueueFullError) {
          await ctx.reply("Queue is full. Please try again in a moment.");
        } else if (err instanceof UserBusyError) {
          await ctx.reply("You already have an image being processed.");
        } else if (err instanceof DuplicateJobError) {
          await ctx.reply("This image is already being processed.");
        } else {
          throw err;
        }
        if (deducted) {
          refundCredit(userId, IMAGE_COST, "queue_reject");
          deducted = false;
        }
      }
    } catch (err) {
      logger.error({ err, userId }, "image pipeline failed");
      writeLog({
        type: "error",
        userId,
        action: "image_pipeline",
        meta: { message: (err as Error)?.message, model: meta.label },
      });
      // Refund-once: the `deducted` flag is flipped to false the moment we
      // refund, so a subsequent throw can never double-refund the same credit.
      if (deducted) {
        refundCredit(userId, IMAGE_COST, "pipeline_failure");
        deducted = false;
      }
      await reporter.finish("Failed. Credit refunded.");
      await safeReply(
        ctx,
        "Failed to process the image. Your credit has been refunded.",
      );
    }
  });
}

/** Build a 2-wide inline keyboard for model selection with a callback prefix. */
export function buildModelKeyboard(
  prefix: string,
  highlightedKey?: string,
): ReturnType<typeof Markup.inlineKeyboard> {
  const buttons = IPHONE_MODELS.map((m) => {
    const label = highlightedKey === m.key ? `⭐ ${m.label}` : m.label;
    return Markup.button.callback(label, `${prefix}:${m.key}`);
  });
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  return Markup.inlineKeyboard(rows);
}

/**
 * Best-effort model suggestion. Downloads the smallest Telegram variant of the
 * uploaded image, measures average luminance, picks a fitting model, and edits
 * the picker message to prepend a "Suggested:" line and star the matching
 * button. Any failure (timeout, CDN error, message no longer editable) is
 * silently dropped — suggestions are pure UX flavor and never block the flow.
 */
async function suggestModelInBackground(
  ctx: BotContext,
  thumbFileId: string,
  chatId: number,
  messageId: number,
  baseText: string,
  baseKeyboard: ReturnType<typeof Markup.inlineKeyboard>,
): Promise<void> {
  try {
    const link = await ctx.telegram.getFileLink(thumbFileId);
    const res = await fetch(link.toString(), {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return;
    const luma = await analyzeBrightness(buf);
    const suggestedKey = pickSuggestedModel(luma);
    const suggested = findModel(suggestedKey);
    if (!suggested) return;
    const newText = `💡 Suggested: ${suggested.label}\n${baseText}`;
    const newKeyboard = buildModelKeyboard("model", suggestedKey);
    await ctx.telegram.editMessageText(
      chatId,
      messageId,
      undefined,
      newText,
      newKeyboard,
    );
  } catch (err) {
    logger.debug({ err }, "suggestion skipped");
  }
}

/**
 * Run the full HEIC + EXIF pipeline for a single image and deliver the result.
 * Exported so the /batch flow can reuse the exact same pipeline (no duplicated
 * EXIF or sensor logic). The optional `StepReporter` lets callers surface live
 * progress; pass `undefined` to stay silent.
 */
export async function processOneImage(
  ctx: BotContext,
  pending: PendingImage,
  meta: NonNullable<ReturnType<typeof findModel>>,
  signal: AbortSignal,
  reporter?: StepReporter,
  captionPrefix?: string,
) {
  const userId = ctx.from!.id;
  const dlId = crypto.randomBytes(6).toString("hex");
  const downloadDir = path.join(TMP_DIR, `dl_${dlId}`);
  await fs.mkdir(downloadDir, { recursive: true });
  let downloadPath: string | undefined;
  let injected: { outputPath: string; cleanup: () => Promise<void> } | undefined;

  try {
    if (reporter) await reporter.start("⏳ Processing started…");

    const link = await ctx.telegram.getFileLink(pending.fileId);
    const res = await fetch(link.toString(), { signal });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);

    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (contentLength && contentLength > MAX_IMAGE_BYTES) {
      throw new Error("image too large");
    }

    const ext = path.extname(new URL(link.toString()).pathname) || ".jpg";
    downloadPath = path.join(downloadDir, `src${ext}`);

    const fileHandle = await fs.open(downloadPath, "w");
    const writeStream = fileHandle.createWriteStream();
    if (!res.body) throw new Error("empty response body");
    await new Promise<void>((resolve, reject) => {
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>)
        .pipe(writeStream)
        .on("finish", () => resolve())
        .on("error", reject);
    });

    const stat = await fs.stat(downloadPath);
    if (stat.size > MAX_IMAGE_BYTES) throw new Error("image too large");

    if (reporter) await reporter.update("📐 Applying camera profile…");

    // 1) Resize the source image to a 48 MP / 4:3 Apple sensor canvas
    //    (8000 x 6000 landscape, or 6000 x 8000 portrait) BEFORE EXIF.
    const resized = await resizeToAppleSensor(downloadPath, meta.megapixels);
    if (signal.aborted) throw new Error("aborted");

    // 2) Look at the actual scene brightness and pick believable
    //    (ISO, shutter) values for it — bright photos get base ISO + a fast
    //    shutter, dim/night photos get high ISO + a slow shutter, just like
    //    iPhone auto-exposure. Without this, every image carries the same
    //    sunny-day numbers, which is a dead giveaway on a dark photo.
    const brightness = await analyzeBrightness(resized.outputPath);
    const exposure = pickRealisticExposure(brightness);
    if (signal.aborted) throw new Error("aborted");

    if (reporter) await reporter.update("🖼 Encoding HEIC…");

    // 3) Re-encode as a real HEIC (HEVC) container, matching the iPhone's
    //    on-device file format so `FileType` reads as HEIC and the Photos.app
    //    "info" sheet shows "HEIF" instead of "JPEG".
    const heic = await encodeAsHeic(resized.outputPath);
    if (signal.aborted) throw new Error("aborted");

    if (reporter) await reporter.update("🏷 Finalizing EXIF…");

    // 4) Inject EXIF metadata into the HEIC. exiftool fully supports writing
    //    EXIF into the HEIC Exif item box, and dimensions are written across
    //    every supported group so any reader reports the same numbers as the
    //    actual encoded image (8000x6000 / 6000x8000 = 48 MP).
    injected = await injectIPhoneExif(
      heic.outputPath,
      meta,
      { width: resized.width, height: resized.height },
      new Date(),
      exposure,
    );

    const caption =
      (captionPrefix ? `${captionPrefix}\n` : "") +
      `Camera: ${meta.model}\n` +
      `Software: iOS ${meta.software}\n` +
      `Lens: ${meta.lensModel}\n` +
      `Aperture: f/${meta.fNumber}\n` +
      `ISO: ${exposure.iso}\n` +
      `Shutter: ${exposure.exposureTimeStr}s\n` +
      `Focal: ${meta.focalLength}mm (${meta.focalLengthIn35mm}mm equiv.)\n` +
      `Sensor: ${meta.megapixels} MP\n` +
      `Output: ${resized.width} x ${resized.height} HEIC (${resized.orientation})`;

    await ctx.replyWithDocument(
      { source: injected.outputPath, filename: path.basename(injected.outputPath) },
      { caption },
    );

    db.prepare(
      "INSERT INTO images(user_id, model, message_id, file_unique, created_at) VALUES(?, ?, ?, ?, ?)",
    ).run(userId, meta.label, pending.messageId, pending.fileUniqueId, nowMs());

    writeLog({
      type: "image",
      userId,
      action: "exif_injected",
      meta: { model: meta.label, remaining: getBalance(userId) },
    });

    if (reporter) await reporter.finish("✅ Completed");
  } finally {
    try {
      await injected?.cleanup();
    } catch {
      /* ignore */
    }
    try {
      await fs.rm(downloadDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
