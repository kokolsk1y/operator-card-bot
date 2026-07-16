// Бот мониторинга цен. Отдельный сервис и отдельный токен — генератор
// карточек (index.mjs в корне) он не трогает.
//
// Уроки, вынесенные из index.mjs, чтобы не повторить:
//  - обработчики регистрируются через Composer, а не свалкой; текстовый
//    catch-all стоит ПОСЛЕДНИМ и ничего не перехватывает у команд;
//  - callback_data с префиксом «pm:», а не плоские «ok»/«no» — иначе
//    два набора кнопок однажды столкнутся;
//  - авторизация есть. Бот знает закупочные цены компании.

import { Bot, InlineKeyboard } from 'grammy';
import { config, assertConfig } from './src/config.mjs';
import {
  openDb, addOurProduct, listOurProducts, getOurProduct,
  pendingCandidates, getCandidate, confirmCandidate, rejectCandidate,
  activeWatched,
} from './src/db.mjs';
import { rub } from './src/wb.mjs';

assertConfig();

const db = openDb(config.dbPath);
const bot = new Bot(config.botToken);

/* ---------- авторизация ---------- */

bot.use(async (ctx, next) => {
  const id = ctx.from?.id;
  if (!id || !config.allowedUsers.includes(id)) {
    // Не объясняем чужому, что это за бот и что он умеет.
    if (ctx.chat) await ctx.reply('Нет доступа.');
    console.warn(`отказ в доступе: user_id=${id ?? '?'}`);
    return;
  }
  await next();
});

/* ---------- состояние диалога заведения товара ---------- */

const STEP = { NAME: 'name', ARTICLE: 'article', PRICE: 'price', VAT: 'vat' };
const draft = new Map(); // chat_id -> {step, name, article, priceKop}

const cancel = (chatId) => draft.delete(chatId);

/* ---------- команды ---------- */

bot.command(['start', 'help'], (ctx) =>
  ctx.reply(
    'Слежу за ценами на маркетплейсах и пишу, когда товар стал дешевле нашей закупочной.\n\n' +
    '/add — завести товар\n' +
    '/list — мои товары\n' +
    '/watch — что отслеживается\n' +
    '/cancel — отменить заведение\n\n' +
    'Как это работает: раз в сутки ищу кандидатов и присылаю на подтверждение. ' +
    'Что подтвердишь — проверяю каждые ' + config.checkEveryMin + ' мин и пишу при падении цены.',
  ));

bot.command('cancel', (ctx) => {
  cancel(ctx.chat.id);
  return ctx.reply('Отменил.');
});

bot.command('add', (ctx) => {
  draft.set(ctx.chat.id, { step: STEP.NAME });
  return ctx.reply(
    'Название товара — как можно точнее, с характеристиками.\n\n' +
    'Например: Лампа LED A60 E27 3000K 11Вт 990Lm IEK\n\n' +
    'Чем полнее название, тем меньше мусора я принесу: по нему я сверяю ' +
    'мощность, цоколь, форму и температуру.',
  );
});

bot.command('list', (ctx) => {
  const items = listOurProducts(db, ctx.from.id);
  if (!items.length) return ctx.reply('Пока пусто. /add — завести товар.');
  const lines = items.map((p) => {
    const vat = p.price_has_vat ? 'с НДС' : 'без НДС';
    const waiting = pendingCandidates(db, p.id).length;
    return `#${p.id} ${p.name}\n   закупочная ${rub(p.price_kop)} (${vat})` +
           (waiting ? `\n   ⏳ ${waiting} кандидат(ов) ждут подтверждения` : '');
  });
  return ctx.reply(lines.join('\n\n'));
});

bot.command('watch', (ctx) => {
  const w = activeWatched(db);
  if (!w.length) return ctx.reply('Ничего не отслеживается. Подтверди кандидатов — начну следить.');
  const lines = w.map((x) =>
    `${x.marketplace.toUpperCase()} ${x.name?.slice(0, 44) ?? '—'}\n` +
    `   ${x.supplier ?? '—'} · лот ${x.pack} шт · последняя ${rub(x.last_price_kop)}`);
  return ctx.reply(`Отслеживаю ${w.length}:\n\n${lines.join('\n\n')}`);
});

/* ---------- диалог заведения ---------- */

bot.on('message:text', async (ctx) => {
  const d = draft.get(ctx.chat.id);
  if (!d) return; // не мешаем ничему другому — catch-all тут не нужен
  const text = ctx.message.text.trim();

  if (d.step === STEP.NAME) {
    d.name = text;
    d.step = STEP.ARTICLE;
    return ctx.reply('Артикул производителя. Если нет — пришли «-».\n\nНапример: LLE-A60-11-230-30-E27');
  }

  if (d.step === STEP.ARTICLE) {
    d.article = text === '-' ? null : text;
    d.step = STEP.PRICE;
    return ctx.reply('Наша закупочная цена ЗА ШТУКУ, в рублях.\n\nНапример: 30 или 30.50');
  }

  if (d.step === STEP.PRICE) {
    const kop = parsePrice(text);
    if (kop == null) return ctx.reply('Не понял цену. Пришли число, например 30 или 30.50');
    d.priceKop = kop;
    d.step = STEP.VAT;
    return ctx.reply(
      `Закупочная ${rub(kop)} — это цена с НДС или без?\n\n` +
      'Это важно: перепутаем — сравнение поедет на 22%, а это больше любой маржи.',
      {
        reply_markup: new InlineKeyboard()
          .text('С НДС', 'pm:vat:1').text('Без НДС', 'pm:vat:0'),
      });
  }
});

/** «30.50» / «30,50» / «30 руб» → копейки. Возвращает null, если не число. */
function parsePrice(text) {
  const m = String(text).replace(',', '.').match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 100);
}

/* ---------- кнопки ---------- */

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith('pm:')) return; // чужие кнопки не наше дело
  const [, kind, arg] = data.split(':');

  if (kind === 'vat') {
    const d = draft.get(ctx.chat.id);
    if (!d || d.step !== STEP.VAT) return ctx.answerCallbackQuery('Заведение уже неактуально');
    const id = addOurProduct(db, {
      name: d.name, article: d.article, priceKop: d.priceKop,
      priceHasVat: arg === '1', vatRate: arg === '1' ? 22 : null,
      ownerId: ctx.from.id,
    });
    cancel(ctx.chat.id);
    await ctx.answerCallbackQuery('Готово');
    return ctx.editMessageText(
      `Товар #${id} заведён.\n\n${d.name}\nзакупочная ${rub(d.priceKop)} ` +
      `(${arg === '1' ? 'с НДС' : 'без НДС'})\n\n` +
      'Первый поиск кандидатов — в ближайший прогон. Пришлю на подтверждение.');
  }

  if (kind === 'cand') {
    const [, , action, idStr] = data.split(':');
    const id = Number(idStr);
    const c = getCandidate(db, id);
    if (!c) return ctx.answerCallbackQuery('Кандидат не найден');

    if (action === 'ok') {
      confirmCandidate(db, id, ctx.from.id);
      await ctx.answerCallbackQuery('Взял в отслеживание');
      return ctx.editMessageText(
        `✅ Отслеживаю\n\n${c.name}\n${c.supplier ?? ''}\n\n` +
        `Проверяю каждые ${config.checkEveryMin} мин, напишу при падении цены.`,
        { link_preview_options: { is_disabled: true } });
    }
    if (action === 'no') {
      rejectCandidate(db, id);
      await ctx.answerCallbackQuery('Больше не предложу');
      return ctx.editMessageText(`❌ Отклонён\n\n${c.name}`);
    }
  }
});

/* ---------- живучесть ---------- */

bot.catch((err) => console.error('ошибка бота:', err));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

console.log(`Бот цен запущен. Доступ у ${config.allowedUsers.length} чел. БД: ${config.dbPath}`);
bot.start();
