// Адаптер Ozon Бизнес (витрина для юрлиц — там живёт бейдж «Возврат НДС»).
//
// Сетевой слой готов, разбор ответа готов и протестирован (ozon-parse.mjs).
// Адаптер ВЫКЛЮЧЕН по умолчанию и включается флагом PRICES_OZON_ENABLED=1
// ТОЛЬКО после успешного probe-ozon.mjs с российского IP — по двум причинам:
//
//   1. Ozon режет иностранные/датацентровые IP (ozon-antibot: 1, «выключите
//      VPN»). С немецкого IP разработки — гарантированный 403. На сервере
//      (Ростелеком, Калининград) должно открыться — там и проверяем.
//   2. Виден ли бейдж «Возврат НДС» БЕЗ логина — пока неизвестно. Если нужен
//      вход, это отдельное решение (бот пойдёт под закупочным аккаунтом).
//
// Пока флаг не выставлен — enabled()=false, и конвейер Озон просто не трогает.
// WB при этом работает.

import { getJson, makeThrottle } from './http.mjs';
import { extractOffers } from './ozon-parse.mjs';

// Озон агрессивнее к частоте, чем WB — интервал больше.
const throttle = makeThrottle(3500);

/** Витрина для юрлиц через composer-api. */
const businessSearchUrl = (query) =>
  'https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=' +
  encodeURIComponent(`/business/search/?text=${query}&from_global=true`);

export async function searchProducts(query, { limit = 60 } = {}) {
  const url = businessSearchUrl(query);
  let json;
  try {
    json = await throttle(() => getJson(url, { attempts: 2, timeoutMs: 25000 }));
  } catch (e) {
    // 403/редирект-петля = антибот по IP. Наверх — понятной строкой.
    throw new Error(`Ozon недоступен (${e.message}). Нужен российский IP (probe-ozon.mjs).`);
  }
  return extractOffers(json).slice(0, limit);
}

/** В разовой модели не используется (finder ходит только через search). */
export async function fetchPrices() {
  return new Map();
}

export const adapter = {
  id: 'ozon',
  title: 'Ozon Бизнес',
  enabled: () => process.env.PRICES_OZON_ENABLED === '1',
  search: searchProducts,
  prices: fetchPrices,
};
