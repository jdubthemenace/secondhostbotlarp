import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FOUNDER_ID = 6982783554;

export const SUPPORT_CONTACT = "@temp688";

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

export const ROOT_DIR = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const TMP_DIR = path.join(ROOT_DIR, "tmp");
export const DB_PATH = path.join(DATA_DIR, "bot.sqlite");
export const BACKUP_DIR = path.join(DATA_DIR, "backups");

export const STARTING_CREDITS = 15;
export const IMAGE_COST = 1;

export const QUEUE_MAX_SIZE = 100;
export const JOB_TIMEOUT_MS = 300_000;
export const DEFAULT_RATE_LIMIT_PER_MIN = 30;

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Max images allowed in a single /batch session. */
export const BATCH_MAX_IMAGES = 5;
/** Inactivity timeout for an open /batch session (5 min). */
export const BATCH_TIMEOUT_MS = 5 * 60 * 1000;
/** Static ETA strings shown in user-facing messages (no fake percentages). */
export const ETA_SINGLE_TEXT = "ETA: 2-5 sec";
export const ETA_BATCH_TEXT = "ETA: ~10-25 sec total";
