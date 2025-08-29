import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';

let bot: TelegramBot | null = null;
let currentBotToken: string | null = null;
let cachedRecipients: TelegramRecipient[] | null = null;
let lastRecipientsFetch = 0;
const RECIPIENTS_CACHE_DURATION = 60000; // 1 minute

interface TelegramRecipient {
  id: string;
  username: string;
  chatId: string | null;
  name: string;
  role?: string;
  active: boolean;
  resolvedAt: string | null;
}

export interface TelegramNotification {
  type: 'success' | 'failure' | 'error' | 'info';
  jobId: string;
  message: string;
  roles?: string[]; // Optional: send only to recipients with these roles
}

async function getRecipients(): Promise<TelegramRecipient[]> {
  const now = Date.now();
  
  // Return cached recipients if still valid
  if (cachedRecipients && (now - lastRecipientsFetch) < RECIPIENTS_CACHE_DURATION) {
    return cachedRecipients;
  }
  
  try {
    // Fetch settings from encode-admin internal API
    const response = await axios.get(`${env.ENCODE_ADMIN_API_URL}/internal/settings`, {
      headers: {
        'X-Internal-Key': env.ENCODE_ADMIN_API_KEY,
      },
    });
    
    if (response.data.telegramRecipients) {
      const recipients = JSON.parse(response.data.telegramRecipients) as TelegramRecipient[];
      cachedRecipients = recipients.filter(r => r.active && r.chatId);
      lastRecipientsFetch = now;
      return cachedRecipients;
    }
  } catch (error) {
    logger.error('Failed to fetch telegram recipients from encode-admin:', error);
  }
  
  return [];
}

async function getBotToken(): Promise<string | null> {
  // First try environment variable
  if (env.TELEGRAM_BOT_TOKEN) {
    return env.TELEGRAM_BOT_TOKEN;
  }
  
  try {
    // Fetch from encode-admin settings
    const response = await axios.get(`${env.ENCODE_ADMIN_API_URL}/internal/settings`, {
      headers: {
        'X-Internal-Key': env.ENCODE_ADMIN_API_KEY,
      },
    });
    
    return response.data.telegramBotToken || null;
  } catch (error) {
    logger.error('Failed to fetch bot token from encode-admin:', error);
    return null;
  }
}

function getTelegramBot(botToken: string): TelegramBot {
  if (!bot || currentBotToken !== botToken) {
    bot = new TelegramBot(botToken, { polling: false });
    currentBotToken = botToken;
  }
  return bot;
}

export async function sendTelegramNotification(
  notification: TelegramNotification
): Promise<void> {
  const botToken = await getBotToken();
  
  if (!botToken) {
    logger.debug('Telegram bot token not configured');
    return;
  }
  
  const telegramBot = getTelegramBot(botToken);
  
  // Get recipients from encode-admin
  const recipients = await getRecipients();
  
  // Filter by roles if specified
  let targetRecipients = recipients;
  if (notification.roles && notification.roles.length > 0) {
    targetRecipients = recipients.filter(r => 
      r.role && notification.roles?.includes(r.role)
    );
  }
  
  // Fallback to legacy chat ID if no recipients configured
  if (targetRecipients.length === 0 && env.TELEGRAM_CHAT_ID) {
    targetRecipients = [{
      id: 'legacy',
      username: 'legacy',
      chatId: env.TELEGRAM_CHAT_ID,
      name: 'Legacy Recipient',
      active: true,
      resolvedAt: null,
    }];
  }
  
  if (targetRecipients.length === 0) {
    logger.debug('No Telegram recipients configured');
    return;
  }

  const emoji = {
    success: '✅',
    failure: '❌',
    error: '⚠️',
    info: 'ℹ️',
  };

  const message = `${emoji[notification.type]} *Import Service*\n\nJob ID: \`${notification.jobId}\`\n\n${notification.message}`;
  
  // Send to all target recipients
  const sendPromises = targetRecipients.map(async (recipient) => {
    if (!recipient.chatId) return;
    
    try {
      await telegramBot.sendMessage(recipient.chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });

      logger.info('Telegram notification sent', {
        type: notification.type,
        jobId: notification.jobId,
        recipient: recipient.name,
      });
    } catch (error) {
      logger.error('Failed to send Telegram notification', {
        error: error instanceof Error ? error.message : String(error),
        notification,
        recipient: recipient.name,
      });
    }
  });
  
  await Promise.all(sendPromises);
}