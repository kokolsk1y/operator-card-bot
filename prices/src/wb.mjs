// Клиент Wildberries поверх публичных эндпоинтов, которыми пользуется их же сайт.
// Авторизация не нужна, ключей нет. Проверено вживую 2026-07-16.
//
// Два режима, и это принципиально разные вещи:
//   searchProducts() — ПОИСК кандидатов. Дорогой и мусорный: выдача почти не
//     учитывает характеристики, а лимиты жёсткие (429 прилетел на 4-м запросе
//     подряд). Гоняем редко.
//   fetchPrices()    — ЦЕНЫ по известным ID. Дешёвый и точный: 60 товаров за
//     один запрос. Гоняем часто.
//
// Все деньги — в КОПЕЙКАХ (целые). В рубли переводим только при показе:
// копейки в double — это потерянные копейки.
//
// Транспорт — http.mjs, а не fetch(). Причины там же в комментарии, коротко:
// fetch не проходит защиту card.wb.ru, и это не лечится заголовками.

import { getJson, makeThrottle } from './http.mjs';

/** Регион доставки. От него зависит цена и наличие — менять осознанно. */
const DEST = -1257786;

/** Скидка постоянного покупателя. Влияет на витринную цену в ответе. */
const SPP = 30;

/** Максимум ID в одном запросе цен. Проверено: 60 проходит. */
const CHUNK = 50;

/** Минимальный интервал между запросами к WB. 429 ловится уже на 4-м подряд. */
const throttle = makeThrottle(1200);

const wbGet = (url) => throttle(() => getJson(url));

/** Достаёт цену из карточки. Структура вложенная и местами пустая. */
function readPrice(p) {
  const price = ((p.sizes || [])[0] || {}).price || {};
  return {
    priceKop: price.product ?? null, // цена к оплате (со скидками)
    basicKop: price.basic ?? null, // цена до скидки
  };
}

function toProduct(p) {
  return {
    marketplace: 'wb',
    id: String(p.id),
    name: p.name || '',
    brand: p.brand || '',
    supplier: p.supplier || '',
    supplierId: p.supplierId ?? null,
    stock: p.totalQuantity ?? null,
    rating: p.reviewRating ?? p.rating ?? null,
    feedbacks: p.nmFeedbacks ?? p.feedbacks ?? null,
    url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
    ...readPrice(p),
  };
}

/**
 * Ищет кандидатов по свободному запросу.
 *
 * ВАЖНО: выдача НЕ отфильтрована по смыслу. WB никогда не отвечает «не найдено»
 * — он всегда набивает страницу похожим мусором. На запрос про лампу
 * «A60 E27 3000K 11Вт IEK» единственное верное совпадение стояло на 34-м месте,
 * а первые 33 были лампами другой мощности и цоколя. Результат ОБЯЗАН пройти
 * через matchProduct() — иначе бот будет слать ерунду.
 */
export async function searchProducts(query, { limit = 100 } = {}) {
  const url =
    'https://search.wb.ru/exactmatch/ru/common/v4/search' +
    `?appType=1&curr=rub&dest=${DEST}&spp=${SPP}` +
    '&resultset=catalog&sort=popular' +
    `&query=${encodeURIComponent(query)}`;

  const data = await wbGet(url);
  const products = data.products || data.data?.products || [];
  return products.slice(0, limit).map(toProduct);
}

/**
 * Цены по списку ID — пачками, поэтому дёшево даже для сотен товаров.
 * Возвращает Map(id -> товар). Пропавшие с витрины ID просто не придут в ответе,
 * и это нормальный случай: товар сняли с продажи.
 */
export async function fetchPrices(ids) {
  const out = new Map();
  for (const chunk of chunks([...new Set(ids.map(String))], CHUNK)) {
    const url =
      'https://card.wb.ru/cards/v4/detail' +
      `?appType=1&curr=rub&dest=${DEST}&spp=${SPP}` +
      `&nm=${chunk.join(';')}`;
    const data = await wbGet(url);
    const products = data.products || data.data?.products || [];
    for (const p of products) out.set(String(p.id), toProduct(p));
  }
  return out;
}

function* chunks(arr, n) {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}

/** Копейки → «63.00 ₽» для показа человеку. */
export const rub = (kop) =>
  kop == null ? '—' : `${(kop / 100).toFixed(2)} ₽`;
