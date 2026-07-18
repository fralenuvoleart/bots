const cron = require("node-cron");
const { createBot } = require("./src/telegram-bot");
const { runWarmer } = require("./src/cache-warmer");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "546485204";
const MSG = require("./config/messages.json");

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN environment variable");
  process.exit(1);
}

// ── Telegram Bot ──
const bot = createBot(BOT_TOKEN, ADMIN_CHAT_ID, MSG);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

bot.launch();
console.log("Bot started — polling for messages");

// ── Cache Warmer (daily at 01:00 UTC) ──
cron.schedule("0 1 * * *", () => {
  console.log("[cron] Starting cache warmer...");
  runWarmer()
    .then(() => console.log("[cron] Cache warmer finished."))
    .catch((err) => console.error("[cron] Cache warmer failed:", err.message));
});

console.log("Cache warmer scheduled daily at 01:00 UTC");
