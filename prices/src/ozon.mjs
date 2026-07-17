// Адаптер Ozon. ПОКА ВЫКЛЮЧЕН — и это не лень, а следствие трёх неизвестных.
//
// Что установлено экспериментом 2026-07-16 (с IP немецкого датацентра):
//   - Обычный запрос уходит в редирект-петлю __rr=1,2,3… до обрыва.
//   - Ответ 403 несёт заголовок «ozon-antibot: 1» и куку abt_data.
//   - Текст страницы: «Выключите VPN, перезагрузите роутер или подключитесь
//     к другой сети». То есть режет РЕПУТАЦИЯ IP, а не признаки робота:
//     Ozon блокирует иностранные и датацентровые адреса.
//   - curl_cffi с impersonate=chrome и headless-Chrome получают тот же 403 —
//     маскировка не помогает, потому что дело не в ней.
//
// Что НЕ установлено, и без чего писать разбор ответа — гадание:
//   1. Пустит ли антибот автоматический клиент с российского IP.
//      Сервер бота (78.36.202.208, Ростелеком, Калининград) — как раз такой.
//   2. Виден ли бейдж «Возврат НДС N%» без входа в аккаунт. Он живёт на
//      витрине ozon.ru/business и на скриншоте снят у залогиненного человека.
//      Если нужен логин — это отдельное решение: бот пойдёт под закупочным
//      аккаунтом компании и подставит под бан ЕГО, а не тестовый IP.
//   3. Структура ответа composer-api. Он отдаёт не список товаров, а набор
//      виджетов, где данные лежат JSON-строками внутри JSON. Разбирать это
//      по памяти нельзя — надо смотреть на живой ответ.
//
// Снять всё три разом: node prices/probe-ozon.mjs с российского IP.
// Пока probe не пройден, adapter.enabled() = false, и конвейер Озон не трогает.

import { getJson, makeThrottle } from './http.mjs';

/** Озон агрессивнее WB — интервал больше. */
const throttle = makeThrottle(3000);

/**
 * Витрина для юрлиц. Именно здесь живёт бейдж «Возврат НДС», ради которого
 * всё и затевалось: он авторитетно сообщает и ставку, и право на вычет.
 */
export const BUSINESS_SEARCH = (text) =>
  'https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=' +
  encodeURIComponent(`/business/search/?text=${text}`);

export const RETAIL_SEARCH = (text) =>
  'https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=' +
  encodeURIComponent(`/search/?text=${text}`);

/**
 * Включается ТОЛЬКО явным разрешением после успешного probe.
 * Переменную ставит человек, убедившийся, что Озон отвечает и разбор написан.
 */
export const adapter = {
  id: 'ozon',
  title: 'Ozon Бизнес',
  enabled: () => process.env.PRICES_OZON_ENABLED === '1',
  search: searchProducts,
  prices: fetchPrices,
};

export async function searchProducts() {
  throw new Error(
    'Адаптер Ozon не готов: не пройден probe-ozon.mjs. ' +
    'Разбор ответа composer-api пишется по живому ответу, а не по памяти.',
  );
}

export async function fetchPrices() {
  throw new Error('Адаптер Ozon не готов: см. probe-ozon.mjs');
}

/** Сырой запрос к composer-api — используется диагностикой. */
export const rawSearch = (url) => throttle(() => getJson(url, { attempts: 1 }));
