import TelegramBot from 'node-telegram-bot-api';
import { env } from '../config/env';
import { logger } from '../utils/logger';

let bot: TelegramBot | null = null;

export interface TelegramNotification {
  type: 'success' | 'failure' | 'error' | 'info';
  jobId: string;
  message: string;
}

function getTelegramBot(): TelegramBot | null {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return null;
  }

  if (!bot) {
    bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: false });
  }

  return bot;
}

export async function sendTelegramNotification(
  notification: TelegramNotification
): Promise<void> {
  const telegramBot = getTelegramBot();
  
  if (!telegramBot || !env.TELEGRAM_CHAT_ID) {
    logger.debug('Telegram notifications not configured');
    return;
  }

  try {
    const emoji = {
      success: '✅',
      failure: '❌',
      error: '⚠️',
      info: 'ℹ️',
    };

    const message = `${emoji[notification.type]} *Import Service*\n\nJob ID: \`${notification.jobId}\`\n\n${notification.message}`;

    await telegramBot.sendMessage(env.TELEGRAM_CHAT_ID, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });

    logger.info('Telegram notification sent', {
      type: notification.type,
      jobId: notification.jobId,
    });
  } catch (error) {
    logger.error('Failed to send Telegram notification', {
      error: error instanceof Error ? error.message : String(error),
      notification,
    });
  }
}