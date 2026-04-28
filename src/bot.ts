import { Telegraf } from "telegraf";
import type { BotContext } from "./middleware.js";
import { globalMiddleware } from "./middleware.js";
import { registerUserCommands } from "./handlers/user.js";
import { registerModeratorCommands } from "./handlers/moderator.js";
import { registerAdminCommands } from "./handlers/admin.js";
import { registerCofounderCommands } from "./handlers/cofounder.js";
import { registerFounderCommands } from "./handlers/founder.js";
import { registerPhotoHandlers } from "./handlers/photo.js";
import { registerBatchHandlers } from "./handlers/batch.js";
import { BOT_TOKEN } from "./config.js";

export function buildBot(): Telegraf<BotContext> {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const bot = new Telegraf<BotContext>(BOT_TOKEN);

  bot.use(globalMiddleware);

  // Order: user -> moderator -> admin -> cofounder -> founder -> batch -> photo
  // Batch is registered BEFORE photo so its photo middleware gets first crack
  // at incoming images and can route them into an open batch session.
  registerUserCommands(bot);
  registerModeratorCommands(bot);
  registerAdminCommands(bot);
  registerCofounderCommands(bot);
  registerFounderCommands(bot);
  registerBatchHandlers(bot);
  registerPhotoHandlers(bot);

  // Unknown commands are ignored safely (no handler).
  return bot;
}
