import type { Telegraf } from "telegraf";
import type { BotCommand } from "telegraf/types";
import type { BotContext } from "./middleware.js";
import type { Role } from "./roles.js";
import { db } from "./db.js";
import { FOUNDER_ID } from "./config.js";
import { logger } from "./logger.js";

interface CmdDef {
  command: string;
  description: string;
}

const USER_CMDS: CmdDef[] = [
  { command: "start", description: "Welcome & quickstart" },
  { command: "help", description: "Show your commands" },
  { command: "credits", description: "Check credit balance" },
  { command: "models", description: "List supported iPhone models" },
  { command: "plan", description: "View your plan & upgrade info" },
  { command: "stats", description: "Your activity stats" },
  { command: "history", description: "Last 10 processed images" },
  { command: "batch", description: "Start a batch (up to 5 images)" },
  { command: "done", description: "Finish the current batch" },
  { command: "referral", description: "Get your referral link" },
  { command: "feedback", description: "Send feedback" },
];

const MOD_CMDS: CmdDef[] = [
  { command: "userinfo", description: "Lookup user by id" },
  { command: "searchuser", description: "Search users" },
  { command: "userhistory", description: "View a user's history" },
  { command: "ban", description: "Ban a user" },
  { command: "unban", description: "Unban a user" },
  { command: "topmodels", description: "Most used iPhone models" },
  { command: "logs", description: "Recent system logs" },
  { command: "feedbacks", description: "Recent feedback" },
  { command: "dm", description: "DM a user" },
];

const ADMIN_CMDS: CmdDef[] = [
  { command: "setcredits", description: "Set a user's credits" },
  { command: "addcredits", description: "Add credits to a user" },
  { command: "takecredits", description: "Take credits from a user" },
  { command: "setplan", description: "Set user plan" },
  { command: "userlist", description: "List recent users" },
  { command: "analytics", description: "Usage analytics" },
  { command: "serverstats", description: "Server stats" },
  { command: "topusers", description: "Top users by usage" },
  { command: "broadcast", description: "Broadcast a message" },
  { command: "clearlogs", description: "Clear logs" },
  { command: "clearfeedback", description: "Clear feedback" },
];

const SUPERADMIN_CMDS: CmdDef[] = [
  { command: "jobs", description: "Recent processed jobs (anonymized)" },
];

const COFOUNDER_CMDS: CmdDef[] = [
  { command: "resetuser", description: "Reset a user record" },
  { command: "banlist", description: "List banned users" },
  { command: "activeusers", description: "Active users right now" },
  { command: "maintenance", description: "Toggle maintenance mode" },
  { command: "lockbot", description: "Lock the bot" },
  { command: "unlockbot", description: "Unlock the bot" },
  { command: "ratelimit", description: "Set rate limit" },
  { command: "giveall", description: "Give credits to all" },
];

const FOUNDER_CMDS: CmdDef[] = [
  { command: "panicmode", description: "Toggle panic mode" },
  { command: "shutdown", description: "Shutdown the bot" },
  { command: "softrestart", description: "Soft restart" },
  { command: "lockall", description: "Lock all features" },
  { command: "unlockall", description: "Unlock all features" },
  { command: "backupdb", description: "Backup the DB" },
  { command: "restoredb", description: "Restore the DB" },
  { command: "inspectdb", description: "Inspect DB tables" },
  { command: "fixdb", description: "Run DB integrity fix" },
  { command: "adminlist", description: "List staff" },
  { command: "addadmin", description: "Promote to admin" },
  { command: "removeadmin", description: "Demote staff" },
  { command: "setrole", description: "Set a user's role" },
  { command: "killqueue", description: "Kill the job queue" },
  { command: "resetpipeline", description: "Reset image pipeline" },
  { command: "debugmode", description: "Toggle debug mode" },
  { command: "fullstats", description: "Full system stats" },
  { command: "systemhealth", description: "System health check" },
  { command: "audituser", description: "Deep audit of a user" },
];

function commandsFor(role: Role): CmdDef[] {
  switch (role) {
    case "banned":
      return [];
    case "user":
      return USER_CMDS;
    case "moderator":
      return [...USER_CMDS, ...MOD_CMDS];
    case "admin":
      return [...USER_CMDS, ...MOD_CMDS, ...ADMIN_CMDS];
    case "superadmin":
      return [...USER_CMDS, ...MOD_CMDS, ...ADMIN_CMDS, ...SUPERADMIN_CMDS];
    case "cofounder":
      return [
        ...USER_CMDS,
        ...MOD_CMDS,
        ...ADMIN_CMDS,
        ...SUPERADMIN_CMDS,
        ...COFOUNDER_CMDS,
      ];
    case "founder":
      return [
        ...USER_CMDS,
        ...MOD_CMDS,
        ...ADMIN_CMDS,
        ...SUPERADMIN_CMDS,
        ...COFOUNDER_CMDS,
        ...FOUNDER_CMDS,
      ];
  }
}

function header(role: Role): string {
  switch (role) {
    case "banned":
      return "🚫 You are banned from this bot.";
    case "user":
      return "🧑 <b>User commands</b>";
    case "moderator":
      return "🛡 <b>Moderator commands</b>";
    case "admin":
      return "⚙️ <b>Admin commands</b>";
    case "superadmin":
      return "🛠 <b>Super Admin commands</b>";
    case "cofounder":
      return "🤝 <b>Co-Founder commands</b>";
    case "founder":
      return "👑 <b>Founder commands</b>";
  }
}

export function helpForRole(role: Role): string {
  if (role === "banned") return header(role);
  const cmds = commandsFor(role);
  const lines = cmds.map((c) => `• /${c.command} — ${c.description}`);
  return `${header(role)}\n\n${lines.join("\n")}`;
}

function toBotCommands(role: Role): BotCommand[] {
  return commandsFor(role).map((c) => ({
    command: c.command,
    description: c.description,
  }));
}

/**
 * Push role-scoped command menus to Telegram so the in-app `/` autocomplete
 * shows the right list per user.
 *
 * - default scope -> regular User commands
 * - per-chat scope (private) -> the staff member's full role list
 */
export async function syncCommandMenus(
  bot: Telegraf<BotContext>,
): Promise<void> {
  // 1) Default (everyone, including unknown users): user-tier commands.
  await bot.telegram.setMyCommands(toBotCommands("user"), {
    scope: { type: "default" },
  });

  // 2) Founder (always).
  await bot.telegram.setMyCommands(toBotCommands("founder"), {
    scope: { type: "chat", chat_id: FOUNDER_ID },
  });

  // 3) Every staff member persisted in DB.
  const rows = db
    .prepare(
      `SELECT user_id, role FROM users
        WHERE role IN ('moderator','admin','superadmin','cofounder','founder')`,
    )
    .all() as { user_id: number; role: Role }[];

  for (const row of rows) {
    if (row.user_id === FOUNDER_ID) continue;
    try {
      await bot.telegram.setMyCommands(toBotCommands(row.role), {
        scope: { type: "chat", chat_id: row.user_id },
      });
    } catch (err) {
      logger.warn(
        { err, userId: row.user_id, role: row.role },
        "setMyCommands failed for staff",
      );
    }
  }
}

/** Push commands for one specific user (call after a role change). */
export async function syncCommandsForUser(
  bot: Telegraf<BotContext>,
  userId: number,
  role: Role,
): Promise<void> {
  try {
    await bot.telegram.setMyCommands(toBotCommands(role), {
      scope: { type: "chat", chat_id: userId },
    });
  } catch (err) {
    logger.warn({ err, userId, role }, "setMyCommands failed");
  }
}
