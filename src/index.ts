import { buildBot } from "./bot.js";
import { logger } from "./logger.js";
import { writeLog } from "./logs.js";
import { syncCommandMenus } from "./command_menu.js";

async function main() {
  const bot = buildBot();

  process.once("SIGINT", () => {
    logger.info("SIGINT received, stopping bot");
    bot.stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    logger.info("SIGTERM received, stopping bot");
    bot.stop("SIGTERM");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandledRejection");
    writeLog({
      type: "error",
      action: "unhandledRejection",
      meta: { reason: String(reason) },
    });
  });
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "uncaughtException");
    writeLog({
      type: "error",
      action: "uncaughtException",
      meta: { message: err.message },
    });
  });

  await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
  bot
    .launch(() => {
      logger.info("bot launched (long polling)");
      writeLog({ type: "system", action: "boot" });
    })
    .catch((err) => {
      logger.error({ err }, "launch failed");
      process.exit(1);
    });

  try {
    const me = await bot.telegram.getMe();
    logger.info({ username: me.username, id: me.id }, "bot identity");
  } catch (err) {
    logger.error({ err }, "getMe failed");
  }

  try {
    await syncCommandMenus(bot);
    logger.info("command menus synced");
  } catch (err) {
    logger.error({ err }, "syncCommandMenus failed");
  }
}

main().catch((err) => {
  logger.error({ err }, "fatal");
  process.exit(1);
});
