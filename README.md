# Telegram Bot — Railway Deployment

Standalone, Railway-ready version of the Telegram Bot Builders bot. Long-polling (no webhook setup needed), so as long as Railway keeps the service running, the bot is online.

---

## What's in here

```
.
├── data/bot.sqlite       # your existing users / credits / logs
├── src/                  # bot source code (TypeScript, run by tsx)
├── package.json
├── tsconfig.json
├── nixpacks.toml         # tells Railway to install libheif + vips
├── railway.json          # restart policy + start command
├── .gitignore
└── README.md
```

---

## Deploy to Railway (from iPhone)

### 1. Get this folder onto GitHub

Easiest path on iOS: install **Working Copy** (free for read-only, paid for push) or use the **GitHub mobile app**.

- Create a new **private** repo on GitHub.
- Upload every file/folder in this project to the repo root (NOT inside an extra subfolder). The repo root must contain `package.json`, `nixpacks.toml`, `src/`, `data/`, etc.

### 2. Create the Railway service

1. Sign in at [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → pick your repo.
2. Railway auto-detects Nixpacks and starts building. Wait for the first build to finish (it'll fail until step 3 — that's expected).

### 3. Add the bot token

1. In your Railway service → **Variables** tab → **+ New Variable**.
2. Name: `TELEGRAM_BOT_TOKEN`
3. Value: paste the token from BotFather.
4. Optional: `LOG_LEVEL=info` (or `debug` for more verbose logs).

Railway will redeploy automatically.

### 4. Persist the SQLite database (IMPORTANT)

By default Railway's filesystem is **ephemeral** — every redeploy wipes `data/bot.sqlite`, which means losing all your users and credits.

To keep the DB across deploys:

1. In your Railway service → **Settings** → **Volumes** → **+ New Volume**.
2. Mount path: `/app/data`
3. Save and redeploy once.

That mounts a persistent volume over the `data/` directory. Your `bot.sqlite` will live there permanently.

> The first time you deploy, the bundled `data/bot.sqlite` (with your existing users) is copied into the volume. After that, the volume is the source of truth.

### 5. Confirm it's alive

- Open the **Deployments** tab → click the latest deployment → **View Logs**.
- You should see lines like `bot launched (long polling)` and `bot identity { username: '...', id: ... }`.
- Send `/start` to your bot in Telegram. It should respond immediately.

---

## Will Railway keep it awake?

Yes. Railway does **not** auto-sleep services on the Hobby plan or higher (unlike Render free tier or some other hosts). As long as the deployment is healthy, the long-polling connection stays open and the bot stays online 24/7.

If the process crashes, `railway.json` is configured to restart it up to 10 times with `ON_FAILURE` policy.

---

## Environment variables

| Variable              | Required | Default | Notes                                                     |
| --------------------- | -------- | ------- | --------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`  | yes      | —       | From [@BotFather](https://t.me/botfather)                 |
| `LOG_LEVEL`           | no       | `info`  | `trace`, `debug`, `info`, `warn`, `error`, `fatal`        |
| `NODE_ENV`            | no       | —       | Set to `production` to disable pretty log formatting      |

---

## Local development (optional)

```bash
npm install
export TELEGRAM_BOT_TOKEN=123456:ABC...
npm run dev
```

Requires Node 22.5+ (for the built-in `node:sqlite` module).

---

## Troubleshooting

- **`heif-enc: command not found`** → make sure `nixpacks.toml` is at the repo root, not inside a subfolder. Railway needs to see it to install `libheif`.
- **Bot replies once, then goes silent** → you probably have two copies running (e.g. old Replit + new Railway). Telegram only allows one long-poller per token. Stop the other one.
- **Lost users after redeploy** → you skipped step 4 (the volume). Add it now; future deploys will persist.
- **Build errors about `sharp`** → already handled by `vips` in `nixpacks.toml`. If it still fails, try `npm rebuild sharp` as a custom build command in Railway settings.
