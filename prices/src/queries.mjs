// Построитель поисковых запросов.
//
// Измерено на живом WB 2026-07-21: запрос полным названием
// «Лампа LED A60 E27 3000K 11Вт 990Lm IEK» вернул ВСЕГО 1 товар — площадка
// не любит длинные запросы. А несколько коротких дали в объединении 37 точных
// совпадений. Поэтому ищем не одним запросом, а пачкой коротких и сливаем.
//
// Идея: из названия достаём характеристики (specs.mjs) и собираем 3-4 «взгляда»
// на товар — по бренду+ключевым характеристикам, по артикулу, по типу+характеристикам.
// Каждый ловит свой срез выдачи; матчер потом отсеивает лишнее.

import { extractSpecs } from './specs.mjs';
import { canon } from './normalize.mjs';

/** Первое слово названия — обычно тип товара («лампа», «розетка»). */
function productType(name) {
  const w = canon(name).split(' ')[0];
  return w && w.length > 2 ? w.toLowerCase() : '';
}

/** Характеристики → компактные токены для запроса. */
function specTokens(specs) {
  const t = [];
  if (specs.shape && /\d/.test(specs.shape)) t.push(specs.shape); // A60, но не «A-ГРУША»
  if (specs.socket) t.push(specs.socket);      // E27
  if (specs.power) t.push(`${specs.power}Вт`); // 11Вт
  if (specs.cct) t.push(`${specs.cct}K`);      // 3000K
  if (specs.keys) t.push(`${specs.keys}кл`);
  if (specs.posts) t.push(`${specs.posts}пост`);
  if (specs.current) t.push(`${specs.current}А`);
  return t;
}

/**
 * Собирает набор запросов для товара. Порядок — от точного к широкому.
 * Дубли и пустышки отсеиваются. Обычно 2-4 запроса.
 *
 * @param {{name:string, article?:string, brand?:string}} product
 * @returns {string[]}
 */
export function buildQueries(product) {
  const specs = extractSpecs(product.name);
  const tokens = specTokens(specs);
  const type = productType(product.name);
  const brand = (product.brand || '').trim();

  const out = [];

  // 1. Бренд + характеристики: «IEK A60 E27 11Вт 3000K».
  //    Самый универсально-надёжный запрос — идёт ПЕРВЫМ, потому что платные
  //    площадки (Ozon) берут только первый запрос ради экономии кредита.
  if (brand && tokens.length) out.push(`${brand} ${tokens.join(' ')}`);

  // 2. Артикул — самый точный сигнал на WB, когда он есть.
  if (product.article && product.article.replace(/[^a-zа-я0-9]/gi, '').length >= 5) {
    out.push(product.article);
  }

  // 3. Тип + характеристики без бренда: «лампа A60 E27 11Вт 3000K».
  //    Ловит перепродавцов, не указавших бренд в названии.
  if (type && tokens.length) out.push(`${type} ${tokens.join(' ')}`);

  // 4. Бренд + тип + пара главных характеристик — пошире, если выше пусто.
  if (brand && type && tokens.length) out.push(`${brand} ${type} ${tokens.slice(0, 2).join(' ')}`);

  // Фолбэк для Ozon-first: если бренда нет, первым будет тип+характеристики.
  if (!out.length && type && tokens.length) out.push(`${type} ${tokens.join(' ')}`);

  // Фолбэк: если характеристик не вытащили (нестандартный товар) — само название.
  if (!out.length) out.push(product.name);

  // Уникализируем без учёта регистра, сохраняя порядок.
  const seen = new Set();
  return out.filter((q) => {
    const k = q.toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
