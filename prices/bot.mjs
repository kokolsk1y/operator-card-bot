// Точка входа сервиса поиска цен.
//
// Отдельный бот, отдельный токен, отдельный контейнер. Генератор карточек
// (index.mjs в корне) не трогается: у него свой Node 20 с rembg и chromium,
// у нас Node 24 ради встроенного node:sqlite.
//
// Модель разовая: /add → поиск → результат. Фонового мониторинга нет.

import { Bot } from 'grammy';
import { config, assertConfig } from './src/config.mjs';
import { openDb } from './src/db.mjs';
import { registerHandlers } from './src/handlers.mjs';
import { enabledMarketplaces } from './src/marketplaces.mjs';

assertConfig();

const db = openDb(config.dbPath);
const bot = new Bot(config.botToken);

registerHandlers(bot, db, { allowedUsers: config.allowedUsers });

// Команды в меню Telegram (кнопка «/»).
bot.api.setMyCommands([
  { command: 'add', description: 'Добавить товар и искать' },
  { command: 'list', description: 'Мои товары' },
  { command: 'check', description: 'Проверить все' },
  { command: 'cancel', description: 'Отменить ввод' },
  { command: 'help', description: 'Как пользоваться' },
]).catch((e) => console.error('setMyCommands:', e.message));

bot.catch((err) => console.error('ошибка бота:', err));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

console.log(`Бот поиска цен запущен. Доступ: ${config.allowedUsers.length || 'открыт всем'}. БД: ${config.dbPath}`);
console.log(`Площадки: ${enabledMarketplaces().map((m) => m.id).join(', ') || 'НИ ОДНОЙ'}`);

bot.start();
