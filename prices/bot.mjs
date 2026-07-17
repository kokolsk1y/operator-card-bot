// Точка входа сервиса мониторинга цен.
//
// Отдельный бот, отдельный токен, отдельный контейнер. Генератор карточек
// (index.mjs в корне) не трогается вообще: у него свой Node 20 с rembg и
// chromium, у нас — Node 24 ради встроенного node:sqlite.
//
// Вся логика в src/: handlers.mjs (диалог), scheduler.mjs (периодика).
// Здесь только сборка и запуск.

import { Bot } from 'grammy';
import { config, assertConfig } from './src/config.mjs';
import { openDb } from './src/db.mjs';
import { registerHandlers } from './src/handlers.mjs';
import { startScheduler } from './src/scheduler.mjs';
import { enabledMarketplaces } from './src/marketplaces.mjs';

assertConfig();

const db = openDb(config.dbPath);
const bot = new Bot(config.botToken);

// Планировщик первым: обработчику /find нужен его runSearch.
// Ставится ДО bot.start() — тот не вернёт управление, пока бот жив.
const jobs = startScheduler(db, bot);

registerHandlers(bot, db, {
  allowedUsers: config.allowedUsers,
  checkEveryMin: config.checkEveryMin,
  runSearch: jobs.runSearch,
});

bot.catch((err) => console.error('ошибка бота:', err));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

console.log(`Бот цен запущен. Доступ у ${config.allowedUsers.length} чел. БД: ${config.dbPath}`);
console.log(`Площадки: ${enabledMarketplaces().map((m) => m.id).join(', ') || 'НИ ОДНОЙ'}`);

bot.start();
