// Разбор ответа Ozon composer-api — УСТОЙЧИВЫЙ к структуре.
//
// composer-api не отдаёт список товаров. Он отдаёт «виджеты»: объект
// widgetStates, где значения — это JSON-СТРОКИ с версток­ой плитки, а ключи
// вида «searchResultsV2-<хэш>-default-1» меняются от релиза к релизу. Зашивать
// эти ключи и точные пути к полям — гарантированно сломаться на первом же
// обновлении Ozon (и я всё равно не могу их подсмотреть с немецкого IP).
//
// Поэтому подход другой: разворачиваем все JSON-строки и РЕКУРСИВНО ищем
// «объекты-плитки» — те, внутри которых есть ссылка /product/. Из каждого
// достаём id, цену, название, бейдж «Возврат НДС». Схему не предполагаем —
// ищем по признакам. На реальном ответе (probe-ozon.mjs сохранит его на
// сервере) точные поля цены с/без НДС можно будет доуточнить.

const PRODUCT_LINK = /\/product\/[^"'\s?]*?(\d{6,})/;
const PRICE = /(\d[\d\s ]{0,12})\s*₽/g;
const VAT_BADGE = /Возврат\s*НДС\s*(\d{1,2})\s*%/i;

/** Строки, которые точно НЕ являются названием товара. */
const NOT_NAME = /₽|%|НДС|корзин|купить|рассрочк|достав|₽\/|отзыв|рейтинг|бонус|ozon|озон/i;

/** Разворачивает widgetStates (значения — JSON-строки) + сам ответ в набор корней. */
function roots(json) {
  const out = [json];
  const buckets = [json?.widgetStates, json?.widgetTrackingInfo].filter(Boolean);
  for (const b of buckets) {
    for (const v of Object.values(b)) {
      if (typeof v === 'string' && (v[0] === '{' || v[0] === '[')) {
        try { out.push(JSON.parse(v)); } catch { /* не JSON — пропускаем */ }
      }
    }
  }
  return out;
}

/** Собирает все строковые значения поддерева до глубины maxDepth. */
function strings(node, maxDepth, out = [], depth = 0) {
  if (depth > maxDepth || node == null) return out;
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) strings(v, maxDepth, out, depth + 1);
  else if (typeof node === 'object') for (const v of Object.values(node)) strings(v, maxDepth, out, depth + 1);
  return out;
}

const priceToKop = (s) => {
  const digits = s.replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) * 100 : null;
};

/** Из поддерева-плитки достаёт предложение или null, если это не товар. */
function buildOffer(tile) {
  const bag = strings(tile, 8);

  const link = bag.find((s) => PRODUCT_LINK.test(s));
  if (!link) return null;
  const id = link.match(PRODUCT_LINK)[1];

  // Цена: берём минимальную из всех «N ₽» — так отсекаем перечёркнутую старую
  // (она выше) и оставляем реальную к оплате.
  const prices = [];
  for (const s of bag) {
    let m;
    PRICE.lastIndex = 0;
    while ((m = PRICE.exec(s))) {
      const kop = priceToKop(m[1]);
      if (kop && kop >= 1000) prices.push(kop); // отсекаем мусор < 10 ₽
    }
  }
  const priceKop = prices.length ? Math.min(...prices) : null;

  // Название: самая длинная «человеческая» строка, не цена и не кнопка.
  const name = bag
    .filter((s) => s.length > 8 && !NOT_NAME.test(s) && /[А-Яа-яA-Za-z].*\s.*[А-Яа-яA-Za-z]/.test(s))
    .sort((a, b) => b.length - a.length)[0] || '';

  // Бейдж возврата НДС — то, ради чего нужна витрина для юрлиц.
  const vatHit = bag.map((s) => s.match(VAT_BADGE)).find(Boolean);

  return {
    marketplace: 'ozon',
    id,
    name: name.slice(0, 200),
    brand: '',
    supplier: '',
    supplierId: null,
    stock: null,
    url: link.startsWith('http') ? link : `https://www.ozon.ru${link.startsWith('/') ? '' : '/'}${link}`,
    priceKop,
    basicKop: prices.length ? Math.max(...prices) : null,
    // Есть бейдж «Возврат НДС N%» → НДС возвращается и ставка известна.
    // Нет бейджа → неизвестно (null): pricing.mjs посчитает по полной цене.
    vatReturnable: vatHit ? true : null,
    vatRate: vatHit ? parseInt(vatHit[1], 10) : null,
  };
}

/** Плитка — это элемент массива, внутри которого (неглубоко) есть /product/. */
function collect(node, found, depth = 0) {
  if (depth > 12 || node == null) return;
  if (Array.isArray(node)) {
    for (const el of node) {
      if (el && typeof el === 'object' && strings(el, 6).some((s) => PRODUCT_LINK.test(s))) {
        const offer = buildOffer(el);
        if (offer && offer.id) {
          const prev = found.get(offer.id);
          // Оставляем вариант с ценой/названием, если прошлый был беднее.
          if (!prev || (offer.priceKop && !prev.priceKop) || (offer.name && !prev.name)) {
            found.set(offer.id, offer);
          }
        }
      }
      collect(el, found, depth + 1);
    }
  } else if (typeof node === 'object') {
    for (const v of Object.values(node)) collect(v, found, depth + 1);
  }
}

/**
 * Главная точка: composer-api JSON → массив предложений (Offer).
 * Пусто = ничего товарного не нашли (другой ответ/структура).
 */
export function extractOffers(composerJson) {
  const found = new Map();
  for (const root of roots(composerJson)) collect(root, found);
  return [...found.values()];
}
