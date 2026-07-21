// Адаптер Ozon через Apify.
//
// Прямой доступ к Озону невозможен: антибот кладёт и HTTP-клиент, и браузер со
// стелсом, и мобильное API — проверено с российского IP (см. память проекта).
// Поэтому ходим через готовый актор Apify (zen-studio/ozon-scraper-pro), который
// держит ферму браузеров + прокси + решает капчу. Он отдаёт чистый JSON.
//
// Оплата PAY_PER_EVENT из бесплатных $5/мес Apify. Поэтому ЭКОНОМИМ:
//   - один запрос на товар (maxQueries: 1), а не четыре как у WB;
//   - скромный maxResults.
// Витрина розничная — бейджа «Возврат НДС» нет, поэтому vatReturnable = null
// (pricing.mjs посчитает по полной цене, честно).

const ACTOR = 'zen-studio~ozon-scraper-pro';
const ENDPOINT = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items`;

const token = () => process.env.PRICES_APIFY_TOKEN || '';

/** Запускает актор и ждёт результат (датасет-элементы). */
async function runActor(input, { timeoutMs = 150000 } = {}) {
  const res = await fetch(`${ENDPOINT}?token=${token()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Apify ответил ${res.status}: ${body.slice(0, 120)}`);
  }
  return res.json();
}

/** Элемент датасета актора → наш Offer. Экспортируется для теста. */
export function toOffer(x) {
  const rub = x.priceDecimal ??
    (x.price ? parseInt(String(x.price).replace(/[^\d]/g, ''), 10) : null);
  const orig = x.originalPriceDecimal ?? null;
  const sku = x.sku != null ? String(x.sku) : '';
  return {
    marketplace: 'ozon',
    id: sku,
    name: x.title || '',
    brand: (x.brand && x.brand.name) || '',
    supplier: x.sellerTag || '',
    supplierId: null,
    stock: null,
    url: x.url || (sku ? `https://www.ozon.ru/product/${sku}/` : ''),
    priceKop: Number.isFinite(rub) ? rub * 100 : null,
    basicKop: Number.isFinite(orig) ? orig * 100 : null,
    // Розница: про НДС витрина молчит → «неизвестно», не выдумываем вычет.
    vatReturnable: null,
    vatRate: null,
  };
}

export async function searchProducts(query, { maxResults = 20 } = {}) {
  if (!token()) throw new Error('PRICES_APIFY_TOKEN не задан');
  const items = await runActor({ queries: [query], maxResults, skipDetails: false });
  return (Array.isArray(items) ? items : [])
    .map(toOffer)
    .filter((o) => o.id && o.name); // без названия матчить нечем
}

export const adapter = {
  id: 'ozon',
  title: 'Ozon',
  enabled: () => !!token(),
  maxQueries: 1, // PAY_PER_EVENT — один запрос на товар, экономим кредит
  search: searchProducts,
};
