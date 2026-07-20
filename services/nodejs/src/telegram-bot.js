const { Telegraf } = require("telegraf");

const INTEGRATELY_WEBHOOK =
  "https://webhooks.integrately.com/a/webhooks/11e1f7e4cb3e4517abcea0d9cd833383";

// ── Helpers ──

/** Retry an async fn up to `retries` times with exponential backoff. */
async function withRetry(fn, retries = 2, label = "") {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i < retries) {
        const ms = 2 ** i * 500;
        console.warn(`[retry ${i + 1}/${retries}] ${label}: ${err.message} — waiting ${ms}ms`);
        await new Promise((r) => setTimeout(r, ms));
      } else {
        console.error(`[failed] ${label}: ${err.message}`);
      }
    }
  }
}

// ── Rate limiter: max 3 messages per user per 10-second window ──
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 3;

function checkRateLimit(userId) {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitMap.set(userId, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_MAX) return false;
  entry.count++;
  return true;
}

// ── Bot factory ──

/**
 * Creates and configures the Telegram bot instance.
 * @param {string} token - Bot token from @BotFather
 * @param {string} adminChatId - Chat ID to forward messages to
 * @param {object} messages - Loaded messages.json content
 * @returns {Telegraf} configured bot instance
 */
function createBot(token, adminChatId, messages) {
  // Deep-clone to prevent env-var overrides from mutating the original require() cache
  const MSG = JSON.parse(JSON.stringify(messages));

  if (process.env.MSG_WELCOME) MSG.welcome.default = process.env.MSG_WELCOME;
  if (process.env.MSG_WELCOME_RU) MSG.welcome.ru = process.env.MSG_WELCOME_RU;
  if (process.env.MSG_AUTOREPLY) MSG.autoreply.default = process.env.MSG_AUTOREPLY;
  if (process.env.MSG_AUTOREPLY_RU) MSG.autoreply.ru = process.env.MSG_AUTOREPLY_RU;

  const t = (key, lang, name) => {
    const msg = MSG[key][lang] || MSG[key].default;
    return name ? msg.replace("{name}", name) : msg;
  };

  const bot = new Telegraf(token);

  // In-memory state: tracks first-contact users and /start deep-link payloads
  const repliedUsers = new Set();
  const startPayloads = new Map();

  bot.on("text", async (ctx) => {
    const text = ctx.message.text;
    const lang = ctx.from?.language_code;

    // /start — welcome message, no forward
    if (text === "/start" || text.startsWith("/start ")) {
      const payload = text.slice("/start".length).trim();
      if (payload) startPayloads.set(ctx.from.id, payload);
      await ctx.reply(t("welcome", lang));
      return;
    }

    // /reset — clear first-message flag for re-testing
    if (text === "/reset") {
      repliedUsers.delete(ctx.from.id);
      startPayloads.delete(ctx.from.id);
      await ctx.reply("State reset. Your next message will be treated as first contact.");
      return;
    }

    // Ignore other bot commands
    if (text.startsWith("/")) return;

    const user = ctx.from;
    const userId = user.id;

    // Rate-limit check
    if (!checkRateLimit(userId)) {
      console.warn(`[rate-limit] Dropping message from user ${userId}`);
      return;
    }

    const name = user.first_name || "User";
    const isFirstMessage = !repliedUsers.has(userId);

    // ── Forward to admin (critical — retry) ──
    await withRetry(() => ctx.forwardMessage(adminChatId), 2, `forward to admin from ${userId}`);

    // ── First-message handling ──
    if (isFirstMessage) {
      repliedUsers.add(userId);

      // Fire-and-forget with retry: notify Integrately
      const payload = startPayloads.get(userId);
      if (payload !== undefined) startPayloads.delete(userId); // clean up

      const webhookBody = JSON.stringify({
        userId,
        firstName: user.first_name,
        lastName: user.last_name,
        username: user.username,
        language: lang,
        message: text,
        startPayload: payload || null,
        timestamp: new Date().toISOString(),
      });

      // Non-blocking: retry webhook in background
      withRetry(
        () =>
          fetch(INTEGRATELY_WEBHOOK, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: webhookBody,
          }).then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
          }),
        2,
        `Integrately webhook for user ${userId}`
      );

      // Auto-reply (retry)
      await withRetry(() => ctx.reply(t("autoreply", lang, name)), 2, `autoreply to ${userId}`);
    }
  });

  return bot;
}

module.exports = { createBot };
