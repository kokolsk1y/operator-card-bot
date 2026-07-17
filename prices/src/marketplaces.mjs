// Реестр площадок. Конвейер (поиск → отсев → отслеживание → уведомления)
// работает через этот интерфейс и про конкретную площадку ничего не знает.
// Добавить Озон = дописать адаптер и включить его здесь.
//
// Общий вид предложения (Offer), который обязан вернуть любой адаптер:
//   {
//     marketplace, id, name, brand, supplier, supplierId,
//     priceKop,      — цена ЛОТА к оплате (не за штуку!)
//     basicKop,      — цена до скидки, может быть null
//     stock, url,
//     vatReturnable, — можно ли принять НДС к вычету: true | false | null
//     vatRate,       — ставка НДС, % — с витрины, НЕ константа
//   }
//
// Про vatReturnable = null. Это «неизвестно», и это ЧЕСТНЫЙ ответ розничной
// витрины WB: она про НДС не знает ничего. pricing.mjs трактует null как
// «вычета нет» и считает по полной цене — то есть ошибается в сторону
// осторожности. Лучше пропустить находку, чем купить в убыток.

import * as wb from './wb.mjs';
import * as ozon from './ozon.mjs';

const ADAPTERS = [wb.adapter, ozon.adapter];

/** Только те, что реально проверены и включены. */
export const enabledMarketplaces = () => ADAPTERS.filter((a) => a.enabled());

export const allMarketplaces = () => ADAPTERS;

export const getMarketplace = (id) => ADAPTERS.find((a) => a.id === id);
