/**
 * Click Battle Telegram bot.
 *
 * The bot is a launcher and a notifier, not a second game client: it opens the
 * Mini App, answers a few read-only questions, and delivers outcome messages.
 * It deliberately cannot start a match, move money or change a setting —
 * those all require a verified Mini App session, and duplicating them here
 * would duplicate the security model too.
 *
 * All user-facing text is English, per the product spec.
 */

import { Bot, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
import { APP_NAME, formatUsdt } from '@cb/shared';
import { env } from './env.js';
import { logger } from './logger.js';
import {
  closeDb,
  linkChatId,
  playerStats,
  takePendingNotifications,
  topPlayers,
  walletFor,
} from './db.js';

const bot = new Bot(env.BOT_TOKEN);

function isAdmin(ctx: Context): boolean {
  const id = ctx.from?.id;
  return id !== undefined && env.adminTelegramIds.includes(BigInt(id));
}

/**
 * The Mini App button.
 *
 * Telegram only renders a `web_app` button for an HTTPS URL. On a local setup
 * MINI_APP_URL is usually http://localhost, which Telegram rejects — so we
 * fall back to a plain link rather than sending a button that silently fails.
 */
function playKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (env.MINI_APP_URL.startsWith('https://')) {
    keyboard.webApp('⚡ PLAY CLICKBATTLE', env.MINI_APP_URL);
  } else if (env.MINI_APP_URL) {
    keyboard.url('⚡ PLAY CLICKBATTLE', env.MINI_APP_URL);
  }
  keyboard.row().text('💰 Balance', 'balance').text('📊 My Stats', 'stats');
  keyboard.row().text('🏆 Leaderboard', 'leaderboard').text('❓ How to Play', 'help');
  return keyboard;
}

const WELCOME = `⚡ *${APP_NAME}* — fastest finger wins\\.

Two players\\. Three rounds\\. One button\\.
When *GO* appears, tap first\\. Win 2 rounds to take the match\\.

*Modes*
🎮 *Free* — play for XP, points and rank
💵 *Paid* — USDT on TON, winner takes the pot
🧪 *Demo* — practise against our AI, no money involved

Tap below to play\\.`;

const HOW_TO_PLAY = `❓ *How to play*

1\\. Pick a mode and tap *Play*\\.
2\\. We match you with another player\\.
3\\. Watch the countdown — then wait\\.
4\\. *GO* appears at a random moment\\. Tap as fast as you can\\.
5\\. Tapping before GO loses the round — don't guess\\.
6\\. First to win 2 of 3 rounds is champion\\.

*Paid matches*
Each player pays the entry\\. A 5% fee is taken from each entry, and the champion takes the rest\\.
Example — a $5 match: each player pays $5, the fee is $0\\.25 each, and the winner receives *$9\\.50*\\.

Your reaction time is measured by our servers, and your network latency is compensated for, so a slower connection doesn't cost you the round\\.`;

// ---------------------------------------------------------------- commands

bot.command('start', async (ctx) => {
  if (ctx.chat.type === 'private' && ctx.from) {
    // Remember the private chat so match results can be delivered later.
    await linkChatId(BigInt(ctx.from.id), BigInt(ctx.chat.id)).catch(() => undefined);
  }
  await ctx.reply(WELCOME, { parse_mode: 'MarkdownV2', reply_markup: playKeyboard() });
});

bot.command('play', async (ctx) => {
  await ctx.reply('Tap to open the game:', { reply_markup: playKeyboard() });
});

bot.command('help', async (ctx) => {
  await ctx.reply(HOW_TO_PLAY, { parse_mode: 'MarkdownV2', reply_markup: playKeyboard() });
});

bot.command('balance', async (ctx) => {
  await respondBalance(ctx);
});

bot.command('stats', async (ctx) => {
  await respondStats(ctx);
});

bot.command('leaderboard', async (ctx) => {
  await respondLeaderboard(ctx);
});

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply('This command is for administrators only.');
    return;
  }
  await ctx.reply(
    'Open the Mini App and use the Admin tab. Your Telegram ID is recognised as an administrator.',
    { reply_markup: playKeyboard() },
  );
});

// ---------------------------------------------------------------- buttons

bot.callbackQuery('balance', async (ctx) => {
  await ctx.answerCallbackQuery();
  await respondBalance(ctx);
});
bot.callbackQuery('stats', async (ctx) => {
  await ctx.answerCallbackQuery();
  await respondStats(ctx);
});
bot.callbackQuery('leaderboard', async (ctx) => {
  await ctx.answerCallbackQuery();
  await respondLeaderboard(ctx);
});
bot.callbackQuery('help', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(HOW_TO_PLAY, { parse_mode: 'MarkdownV2' });
});

// ---------------------------------------------------------------- responders

async function respondBalance(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const wallet = await walletFor(BigInt(ctx.from.id));
  if (!wallet) {
    await ctx.reply('Open the app once to set up your wallet.', { reply_markup: playKeyboard() });
    return;
  }

  const lines = [
    '💰 *Your wallet*',
    '',
    `Available: *${escape(formatUsdt(wallet.available))}*`,
  ];
  if (wallet.locked > 0n) {
    lines.push(`In play: ${escape(formatUsdt(wallet.locked))}`);
  }
  lines.push('', 'Deposit and withdraw from the Wallet tab in the app\\.');

  await ctx.reply(lines.join('\n'), { parse_mode: 'MarkdownV2', reply_markup: playKeyboard() });
}

async function respondStats(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const stats = await playerStats(BigInt(ctx.from.id));
  if (!stats) {
    await ctx.reply('Play your first match to build some stats!', { reply_markup: playKeyboard() });
    return;
  }

  const winRate = stats.totalMatches > 0 ? Math.round((stats.wins / stats.totalMatches) * 100) : 0;
  const text = [
    '📊 *Your stats*',
    '',
    `Level *${stats.level}* · ${escape(String(stats.xp))} XP · ${escape(String(stats.points))} points`,
    `Rank: *${stats.rank ? `#${stats.rank}` : 'unranked'}*`,
    '',
    `Matches: ${stats.totalMatches}`,
    `Wins: ${stats.wins} · Losses: ${stats.losses} · Win rate: ${winRate}%`,
    stats.bestReactionMs ? `Best reaction: *${stats.bestReactionMs} ms*` : 'Best reaction: —',
    `Current streak: ${stats.currentStreak} · Best: ${stats.bestStreak}`,
  ].join('\n');

  await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: playKeyboard() });
}

async function respondLeaderboard(ctx: Context): Promise<void> {
  const top = await topPlayers(10);
  if (top.length === 0) {
    await ctx.reply('No ranked players yet. Be the first!', { reply_markup: playKeyboard() });
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const rows = top.map((player, index) => {
    const badge = medals[index] ?? `${index + 1}\\.`;
    return `${badge} ${escape(player.displayName)} — Lv${player.level} · ${escape(String(player.points))} pts`;
  });

  await ctx.reply(['🏆 *Top players*', '', ...rows].join('\n'), {
    parse_mode: 'MarkdownV2',
    reply_markup: playKeyboard(),
  });
}

/** MarkdownV2 requires escaping a specific set of characters. */
function escape(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (char) => `\\${char}`);
}

// ---------------------------------------------------------------- notifications

/**
 * Outbound notification drain.
 *
 * The backend writes rows to `notifications`; the bot delivers them. Decoupling
 * it this way means a Telegram outage delays messages instead of failing a
 * match settlement — the money is already recorded either way.
 */
async function drainNotifications(): Promise<void> {
  const pending = await takePendingNotifications(20).catch((error) => {
    logger.warn({ err: error }, 'could not read notifications');
    return [];
  });

  for (const notification of pending) {
    if (!notification.chatId) continue;
    try {
      await bot.api.sendMessage(Number(notification.chatId), notification.text, {
        parse_mode: 'MarkdownV2',
        reply_markup: playKeyboard(),
      });
      await notification.markSent();
    } catch (error) {
      // A user who blocked the bot must not jam the queue forever.
      const permanent = error instanceof GrammyError && [400, 403].includes(error.error_code);
      await notification.markFailed(error instanceof Error ? error.message : 'send failed', permanent);
      logger.warn({ err: error, id: notification.id }, 'notification delivery failed');
    }
  }
}

// ---------------------------------------------------------------- lifecycle

bot.catch((error) => {
  const context = error.error;
  if (context instanceof GrammyError) logger.error({ err: context }, 'telegram API error');
  else if (context instanceof HttpError) logger.error({ err: context }, 'could not reach Telegram');
  else logger.error({ err: context }, 'bot error');
});

/** Retry transient network failures (for example EAI_AGAIN/DNS outages).
 * Telegram API errors such as an invalid token are not retried indefinitely.
 */
async function withTelegramNetworkRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
  let delayMs = 1_000;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      logger.warn({ err: error, retryInMs: delayMs }, `Telegram network request failed during ${label}; retrying`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }
}

async function main(): Promise<void> {
  if (!env.BOT_TOKEN) {
    logger.error('BOT_TOKEN is not set — the bot cannot start.');
    process.exit(1);
  }

  await withTelegramNetworkRetry(() => bot.api.setMyCommands([
    { command: 'start', description: 'Open Click Battle' },
    { command: 'play', description: 'Play a match' },
    { command: 'balance', description: 'Check your USDT balance' },
    { command: 'stats', description: 'Your level, rank and record' },
    { command: 'leaderboard', description: 'Top players' },
    { command: 'help', description: 'How to play' },
  ]), 'setMyCommands');

  const notifier = setInterval(() => void drainNotifications(), 5_000);
  notifier.unref();

  if (env.BOT_WEBHOOK_URL) {
    // Webhook mode is handled by the deployment's HTTP layer; here we only
    // register the endpoint so Telegram knows where to deliver.
    await withTelegramNetworkRetry(() => bot.api.setWebhook(env.BOT_WEBHOOK_URL!, {
      secret_token: env.BOT_WEBHOOK_SECRET || undefined,
      drop_pending_updates: true,
    }), 'setWebhook');
    logger.info({ url: env.BOT_WEBHOOK_URL }, 'webhook registered');
  } else {
    await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => undefined);
    logger.info({ username: env.BOT_USERNAME }, 'starting long polling');
    void bot.start({ onStart: (info) => logger.info({ username: info.username }, 'bot online') });
  }

  const shutdown = async (): Promise<void> => {
    clearInterval(notifier);
    await bot.stop().catch(() => undefined);
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  logger.fatal({ err: error }, 'bot failed to start');
  process.exit(1);
});
