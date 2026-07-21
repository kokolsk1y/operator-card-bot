// Обработчики бота. Вынесены из точки входа, чтобы прогонять тестом через
// bot.handleUpdate() без Telegram, токена и сети.
//
// Модель разовая: /add заводит товар и СРАЗУ ищет; /list — список с кнопками
// «Проверить · Удалить»; /check — проверить все. Никакого фонового мониторинга.
//
// Порядок middleware — несущая конструкция: обработчик текста, который «не про
// него», обязан вызвать next(), иначе убьёт всё зарегистрированное после
// (ровно этот баг живёт в index.mjs генератора карточек).

import { InlineKeyboard } from 'grammy';
import {
  addProduct, listProducts, getProduct, deleteProduct, recordCheck,
} from './db.mjs';
import { searchProduct } from './finder.mjs';
import { enabledMarketplaces } from './marketplaces.mjs';
import { renderSearch, renderProductRow, esc } from './view.mjs';

const STEP = { NAME: 'name', ARTICLE: 'article', PRICE: 'price' };

/** «30.50» / «30,50» / «30 руб» → копейки. null, если не число. */
export function parsePrice(text) {
  const m = String(text).replace(',', '.').match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
}

/** Строка целиком — это цена? «30», «30.50», «30 руб», «цена 30». */
const looksLikePrice = (s) => /^\s*(цена[:\s]*)?\d+([.,]\d{1,2})?\s*(р|руб|₽)?\.?\s*$/i.test(s);

/** Строка похожа на артикул: буквы+цифры и/или дефисы, без пробелов внутри. */
const looksLikeArticle = (s) => /^[A-Za-zА-Яа-я0-9]+([-/][A-Za-zА-Яа-я0-9]+)+$/.test(s.trim()) ||
  /^[A-Za-z]{2,}\d{2,}/.test(s.trim());

/**
 * Разбирает многострочную вставку в товар. Пользователь удобнее шлёт всё
 * разом: название / артикул / цена на разных строках. Определяем строки по
 * форме: число = цена, «код-с-дефисами» = артикул, остальное = название.
 *
 * @returns {{name, article, priceKop}} любое поле может быть null.
 */
export function parseProductBlock(text) {
  const lines = String(text).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return { name: null, article: null, priceKop: null };

  let name = null, article = null, priceKop = null;
  const nameParts = [];
  for (const line of lines) {
    if (priceKop == null && looksLikePrice(line)) { priceKop = parsePrice(line); continue; }
    if (article == null && looksLikeArticle(line) && line.split(/\s+/).length === 1) { article = line; continue; }
    nameParts.push(line);
  }
  name = nameParts.join(' ').trim() || null;
  return { name, article, priceKop };
}

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

const rowKeyboard = (id) =>
  new InlineKeyboard()
    .text('🔎 Проверить', `pm:check:${id}`)
    .text('🗑', `pm:del:${id}`);

export function registerHandlers(bot, db, opts = {}) {
  // searchFn внедряется в тестах, чтобы не ходить в сеть. По умолчанию — боевой.
  const { allowedUsers = [], searchFn = searchProduct } = opts;
  const draft = new Map(); // chat_id -> {step, name, article}
  const open = allowedUsers.length === 0;

  /* ---------- доступ ----------
     Пустой allowedUsers = открытый режим. Безопасен потому, что всё ниже
     фильтруется по ctx.from.id: чужие товары и цены не видны. */
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id) return;
    if (!open && !allowedUsers.includes(id)) {
      if (ctx.chat) await ctx.reply('Нет доступа.');
      return;
    }
    await next();
  });

  /* ---------- поиск по товару (общая процедура) ---------- */

  async function runSearch(ctx, product) {
    const note = await ctx.reply('🔎 Ищу на маркетплейсах…');
    try {
      const search = await searchFn(product);
      recordCheck(db, product.id, { found: search.stats.found, deals: search.stats.deals });
      const text = renderSearch(product, search);
      // Правим сообщение-заглушку результатом — чат не засоряется.
      await ctx.api.editMessageText(ctx.chat.id, note.message_id, text, HTML);
    } catch (e) {
      console.error('поиск упал:', e);
      await ctx.api.editMessageText(ctx.chat.id, note.message_id,
        '⚠️ Не получилось выполнить поиск. Попробуй ещё раз через минуту.');
    }
  }

  /* ---------- команды ---------- */

  bot.command(['start', 'help'], (ctx) => {
    const mps = enabledMarketplaces().map((m) => m.title).join(', ') || 'настраиваются';
    return ctx.reply(
      '👋 Ищу твои товары на маркетплейсах дешевле твоей закупочной.\n\n' +
      '<b>Как это работает</b>\n' +
      '1. /add — заводишь товар (название, артикул, твоя цена)\n' +
      '2. Сразу показываю, что нашлось дешевле — со ссылками\n' +
      '3. /list — список товаров, любой перепроверить кнопкой\n\n' +
      '<b>Команды</b>\n' +
      '/add — добавить товар и искать\n' +
      '/list — мои товары\n' +
      '/check — проверить все разом\n' +
      '/cancel — отменить ввод\n\n' +
      `<i>Площадки: ${esc(mps)}</i>`,
      { parse_mode: 'HTML' });
  });

  bot.command('cancel', (ctx) => {
    draft.delete(ctx.chat.id);
    return ctx.reply('Отменил.');
  });

  bot.command('add', (ctx) => {
    // Всё, что после «/add» — включая перенос строки и следующие строки.
    const payload = (ctx.match || '').trim();
    if (payload) return startAdd(ctx, payload);

    draft.set(ctx.chat.id, { step: STEP.NAME });
    return ctx.reply(
      '📝 <b>Название товара</b> — с характеристиками, как можно точнее.\n\n' +
      'Например:\n<code>Лампа LED A60 E27 3000K 11Вт 990Lm IEK</code>\n\n' +
      'Можно прислать всё разом — название, артикул и цену на отдельных строках:\n' +
      '<code>Лампа LED A60 E27 3000K 11Вт IEK\nLLE-A60-11-230-30-E27\n30</code>',
      { parse_mode: 'HTML' });
  });

  /**
   * Разбирает введённый блок и решает: искать сразу или чего-то не хватает.
   * Используется и из «/add <текст>», и с первого сообщения в диалоге.
   */
  async function startAdd(ctx, text) {
    const { name, article, priceKop } = parseProductBlock(text);
    if (!name) {
      draft.set(ctx.chat.id, { step: STEP.NAME });
      return ctx.reply('📝 Пришли название товара с характеристиками.');
    }
    if (priceKop != null) {
      // Есть всё нужное — заводим и сразу ищем.
      return finishAdd(ctx, { name, article }, priceKop);
    }
    // Название есть, цены нет — дособерём. Артикул сохраним, если был.
    draft.set(ctx.chat.id, { step: STEP.PRICE, name, article: article ?? null });
    if (article) return askPrice(ctx);
    draft.get(ctx.chat.id).step = STEP.ARTICLE;
    return ctx.reply(
      '🔖 <b>Артикул производителя</b> — сильно повышает точность.\nЕсли нет — «Пропустить».',
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('Пропустить', 'pm:noart') });
  }

  bot.command('list', (ctx) => {
    const items = listProducts(db, ctx.from.id);
    if (!items.length) return ctx.reply('Пока пусто. /add — завести товар.');
    // Каждый товар — отдельным сообщением со своими кнопками.
    return (async () => {
      await ctx.reply(`📦 Твои товары (${items.length}):`);
      for (const p of items) {
        await ctx.reply(renderProductRow(p), { ...HTML, reply_markup: rowKeyboard(p.id) });
      }
    })();
  });

  bot.command('check', async (ctx) => {
    const items = listProducts(db, ctx.from.id);
    if (!items.length) return ctx.reply('Нет товаров. /add — завести.');
    await ctx.reply(`🔎 Проверяю все ${items.length}. Это займёт минуту — держу паузы, иначе маркетплейс злится.`);
    for (const p of items) await runSearch(ctx, p);
    await ctx.reply('✅ Готово.');
  });

  /* ---------- диалог заведения ---------- */

  bot.on('message:text', async (ctx, next) => {
    const d = draft.get(ctx.chat.id);
    if (!d) return next(); // не начат диалог — пропускаем дальше (НЕ съедаем команды)

    const text = ctx.message.text.trim();

    if (d.step === STEP.NAME) {
      // На шаге названия тоже принимаем пачку: пользователь мог прислать
      // /add, а следом название/артикул/цену одним блоком.
      draft.delete(ctx.chat.id);
      return startAdd(ctx, text);
    }

    if (d.step === STEP.ARTICLE) {
      d.article = text === '-' ? null : text;
      d.step = STEP.PRICE;
      return askPrice(ctx);
    }

    if (d.step === STEP.PRICE) {
      const kop = parsePrice(text);
      if (kop == null) return ctx.reply('Не понял цену. Пришли число, например 30 или 30.50');
      return finishAdd(ctx, d, kop);
    }
  });

  const askPrice = (ctx) => ctx.reply(
    '💰 <b>Наша закупочная цена за ШТУКУ</b>, в рублях.\n\nНапример: <code>30</code> или <code>30.50</code>',
    { parse_mode: 'HTML' });

  async function finishAdd(ctx, d, priceKop) {
    // Бренд угадываем из названия — последнее «слово из заглавных/латиницы».
    const id = addProduct(db, {
      name: d.name, article: d.article, brand: guessBrand(d.name),
      priceKop, priceHasVat: false, vatRate: null, ownerId: ctx.from.id,
    });
    draft.delete(ctx.chat.id);
    const product = getProduct(db, id, ctx.from.id);
    await ctx.reply(`✅ Товар <b>#${id}</b> сохранён. Ищу…`, { parse_mode: 'HTML' });
    await runSearch(ctx, product);
  }

  /* ---------- кнопки ---------- */

  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith('pm:')) return next();
    const [, kind, arg] = data.split(':');

    if (kind === 'noart') {
      const d = draft.get(ctx.chat.id);
      if (!d || d.step !== STEP.ARTICLE) return ctx.answerCallbackQuery('Уже неактуально');
      d.article = null;
      d.step = STEP.PRICE;
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({}); // убираем кнопку
      return askPrice(ctx);
    }

    if (kind === 'check') {
      const p = getProduct(db, Number(arg), ctx.from.id);
      if (!p) return ctx.answerCallbackQuery('Товар не найден');
      await ctx.answerCallbackQuery('Ищу…');
      return runSearch(ctx, p);
    }

    if (kind === 'del') {
      const ok = deleteProduct(db, Number(arg), ctx.from.id);
      await ctx.answerCallbackQuery(ok ? 'Удалён' : 'Не найден');
      if (ok) await ctx.editMessageText('🗑 Удалён.');
      return;
    }
  });
}

/** Грубая догадка бренда: латинское/капсовое слово в названии. */
function guessBrand(name) {
  const cands = String(name).match(/\b[A-ZА-Я][A-Za-zА-Яа-я]{2,}\b/g) || [];
  // Отсекаем очевидные не-бренды.
  const stop = new Set(['LED', 'Лампа', 'Лампочка', 'Розетка', 'Выключатель']);
  const hit = cands.reverse().find((w) => !stop.has(w) && /[A-Z]{2,}/.test(w));
  return hit || null;
}
