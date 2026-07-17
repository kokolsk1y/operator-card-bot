// Обработчики бота. Вынесены из точки входа, чтобы их можно было прогнать
// тестом через bot.handleUpdate() — без Telegram, токена и сети.
//
// Порядок регистрации здесь — не косметика, а несущая конструкция.
// В index.mjs генератора карточек обработчик текста стоит catch-all'ом без
// next(), и всё зарегистрированное после него молча мертво. Здесь каждый
// обработчик, который «не про него», обязан вызвать next().

import { InlineKeyboard } from 'grammy';
import {
  addOurProduct, listOurProducts, pendingCandidates,
  getCandidate, confirmCandidate, rejectCandidate, activeWatched,
} from './db.mjs';
import { rub } from './wb.mjs';
import { enabledMarketplaces } from './marketplaces.mjs';

const STEP = { NAME: 'name', ARTICLE: 'article', PRICE: 'price', VAT: 'vat' };

/** «30.50» / «30,50» / «30 руб» → копейки. null, если не число. */
export function parsePrice(text) {
  const m = String(text).replace(',', '.').match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
}

/**
 * @param {import('grammy').Bot} bot
 * @param {object} db
 * @param {{allowedUsers:number[], checkEveryMin:number, runSearch?:Function}} opts
 */
export function registerHandlers(bot, db, opts) {
  const { allowedUsers, checkEveryMin = 20, runSearch } = opts;
  const draft = new Map(); // chat_id -> {step, ...}

  /* ---------- авторизация ---------- */
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id || !allowedUsers.includes(id)) {
      // Чужому не объясняем, что это за бот и что он умеет.
      if (ctx.chat) await ctx.reply('Нет доступа.');
      console.warn(`отказ в доступе: user_id=${id ?? '?'}`);
      return; // здесь обрыв цепочки — единственное место, где он уместен
    }
    await next();
  });

  /* ---------- команды ---------- */

  bot.command(['start', 'help'], (ctx) =>
    ctx.reply(
      'Слежу за ценами на маркетплейсах и пишу, когда товар стал дешевле нашей закупочной.\n\n' +
      '/add — завести товар\n/list — мои товары\n/watch — что отслеживается\n' +
      '/find — искать кандидатов прямо сейчас\n/cancel — отменить заведение\n\n' +
      `Раз в сутки ищу кандидатов и присылаю на подтверждение. Что подтвердишь — ` +
      `проверяю каждые ${checkEveryMin} мин и пишу при падении цены.\n\n` +
      `Площадки: ${enabledMarketplaces().map((m) => m.title).join(', ') || 'ни одной'}`));

  bot.command('cancel', (ctx) => {
    draft.delete(ctx.chat.id);
    return ctx.reply('Отменил.');
  });

  bot.command('add', (ctx) => {
    draft.set(ctx.chat.id, { step: STEP.NAME });
    return ctx.reply(
      'Название товара — как можно точнее, с характеристиками.\n\n' +
      'Например: Лампа LED A60 E27 3000K 11Вт 990Lm IEK\n\n' +
      'Чем полнее название, тем меньше мусора принесу: по нему сверяю ' +
      'мощность, цоколь, форму и температуру.');
  });

  bot.command('list', (ctx) => {
    const items = listOurProducts(db, ctx.from.id);
    if (!items.length) return ctx.reply('Пока пусто. /add — завести товар.');
    return ctx.reply(items.map((p) => {
      const waiting = pendingCandidates(db, p.id).length;
      return `#${p.id} ${p.name}\n   закупочная ${rub(p.price_kop)} ` +
             `(${p.price_has_vat ? 'с НДС' : 'без НДС'})` +
             (waiting ? `\n   ⏳ ${waiting} кандидат(ов) ждут подтверждения` : '');
    }).join('\n\n'));
  });

  bot.command('watch', (ctx) => {
    const w = activeWatched(db);
    if (!w.length) return ctx.reply('Ничего не отслеживается. Подтверди кандидатов — начну следить.');
    return ctx.reply(`Отслеживаю ${w.length}:\n\n` + w.map((x) =>
      `${x.marketplace.toUpperCase()} ${x.name?.slice(0, 44) ?? '—'}\n` +
      `   ${x.supplier ?? '—'} · лот ${x.pack} шт · последняя ${rub(x.last_price_kop)}`).join('\n\n'));
  });

  bot.command('find', async (ctx) => {
    if (!enabledMarketplaces().length) return ctx.reply('Ни одной площадки не включено.');
    if (!runSearch) return ctx.reply('Планировщик не подключён.');
    await ctx.reply('Ищу… с полминуты: между запросами держу паузу, иначе прилетит 429.');
    await runSearch();
    return ctx.reply('Готово. Что нашлось — прислал отдельными сообщениями.');
  });

  /* ---------- диалог заведения ---------- */

  bot.on('message:text', async (ctx, next) => {
    const d = draft.get(ctx.chat.id);
    // Диалог не начат — пропускаем дальше. Именно здесь в index.mjs стоит
    // `return ctx.reply(...)` без next(), из-за чего всё, что после, мертво.
    if (!d) return next();

    const text = ctx.message.text.trim();

    if (d.step === STEP.NAME) {
      d.name = text;
      d.step = STEP.ARTICLE;
      return ctx.reply('Артикул производителя. Если нет — пришли «-».\n\nНапример: LLE-A60-11-230-30-E27');
    }
    if (d.step === STEP.ARTICLE) {
      d.article = text === '-' ? null : text;
      d.step = STEP.PRICE;
      return ctx.reply('Наша закупочная ЗА ШТУКУ, в рублях.\n\nНапример: 30 или 30.50');
    }
    if (d.step === STEP.PRICE) {
      const kop = parsePrice(text);
      if (kop == null) return ctx.reply('Не понял цену. Пришли число, например 30 или 30.50');
      d.priceKop = kop;
      d.step = STEP.VAT;
      return ctx.reply(
        `Закупочная ${rub(kop)} — это цена с НДС или без?\n\n` +
        'Перепутаем — сравнение поедет на 22%, а это больше любой маржи.',
        { reply_markup: new InlineKeyboard().text('С НДС', 'pm:vat:1').text('Без НДС', 'pm:vat:0') });
    }
  });

  /* ---------- кнопки ---------- */

  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith('pm:')) return next(); // чужие кнопки не наше дело

    const parts = data.split(':');
    const kind = parts[1];

    if (kind === 'vat') {
      const d = draft.get(ctx.chat.id);
      if (!d || d.step !== STEP.VAT) return ctx.answerCallbackQuery('Заведение уже неактуально');
      const hasVat = parts[2] === '1';
      const id = addOurProduct(db, {
        name: d.name, article: d.article, priceKop: d.priceKop,
        priceHasVat: hasVat, vatRate: hasVat ? 22 : null, ownerId: ctx.from.id,
      });
      draft.delete(ctx.chat.id);
      await ctx.answerCallbackQuery('Готово');
      return ctx.editMessageText(
        `Товар #${id} заведён.\n\n${d.name}\nзакупочная ${rub(d.priceKop)} ` +
        `(${hasVat ? 'с НДС' : 'без НДС'})\n\n/find — искать прямо сейчас.`);
    }

    if (kind === 'cand') {
      const action = parts[2];
      const c = getCandidate(db, Number(parts[3]));
      if (!c) return ctx.answerCallbackQuery('Кандидат не найден');

      if (action === 'ok') {
        confirmCandidate(db, c.id, ctx.from.id);
        await ctx.answerCallbackQuery('Взял в отслеживание');
        return ctx.editMessageText(
          `✅ Отслеживаю\n\n${c.name}\n${c.supplier ?? ''}\n\n` +
          `Проверяю каждые ${checkEveryMin} мин, напишу при падении цены.`,
          { link_preview_options: { is_disabled: true } });
      }
      if (action === 'no') {
        rejectCandidate(db, c.id);
        await ctx.answerCallbackQuery('Больше не предложу');
        return ctx.editMessageText(`❌ Отклонён\n\n${c.name}`);
      }
    }
  });
}
