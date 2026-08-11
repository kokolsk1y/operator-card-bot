// Адаптер Ozon через Apify.
//
// Прямой доступ к Озону невозможен: антибот кладёт и HTTP-клиент, и браузер со
// стелсом, и мобильное API — проверено с российского IP (см. память проекта).
// Поэтому ходим через готовый актор Apify (zen-studio/ozon-scraper-pro), который
// держит ферму браузеров + прокси + решает капчу. Он отдаёт чистый JSON.
//
// Оплата PAY_PER_EVENT. Поэтому сначала берём дешёвые поисковые плитки, а
// полную карточку запрашиваем только для кандидатов, прошедших наш матчер.
// Витрина розничная — бейджа «Возврат НДС» нет, поэтому vatReturnable = null
// (pricing.mjs посчитает по полной цене, честно).

const ACTOR = 'zen-studio~ozon-scraper-pro';
const ENDPOINT = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items`;
const RUNS_ENDPOINT = `https://api.apify.com/v2/acts/${ACTOR}/runs`;

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

/**
 * Полные карточки могут собираться дольше 2 минут. Длинное HTTP-соединение
 * периодически обрывалось с `fetch failed`, хотя запуск Apify продолжал работу.
 * Поэтому запускаем асинхронно, ждём короткими запросами и забираем dataset.
 */
async function runActorAsync(input, { timeoutMs = 280000 } = {}) {
  const auth = `token=${encodeURIComponent(token())}`;
  const started = await fetch(`${RUNS_ENDPOINT}?${auth}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30000),
  });
  if (!started.ok) {
    const body = await started.text().catch(() => '');
    throw new Error(`Apify не запустил сбор: ${started.status} ${body.slice(0, 120)}`);
  }
  let run = (await started.json()).data;
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

  while (!terminal.has(run.status) && Date.now() < deadline) {
    try {
      const statusRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${run.id}?${auth}`,
        { signal: AbortSignal.timeout(15000) },
      );
      if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status}`);
      run = (await statusRes.json()).data;
    } catch (error) {
      // Один сетевой сбой не отменяет уже оплаченный запуск: повторяем до общего deadline.
      console.warn(`Apify статус временно недоступен: ${error.message}`);
    }
    if (!terminal.has(run.status)) await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  if (run.status !== 'SUCCEEDED') {
    throw new Error(`Apify завершил сбор со статусом ${run.status || 'TIMEOUT'}`);
  }
  const itemsRes = await fetch(
    `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?${auth}&clean=true`,
    { signal: AbortSignal.timeout(30000) },
  );
  if (!itemsRes.ok) throw new Error(`Apify не отдал результат: ${itemsRes.status}`);
  return itemsRes.json();
}

/** Элемент датасета актора → наш Offer. Экспортируется для теста. */
export function toOffer(x, { details = false } = {}) {
  const card = money(x.cardPriceDecimal, x.cardPrice);
  const regular = money(x.priceDecimal, x.price);
  const orig = money(x.originalPriceDecimal, x.originalPrice);
  // На полной карточке Ozon отдельно отдаёт цену по карте/акции. Именно её
  // пользователь обычно видит крупной при переходе. Старая зачёркнутая цена
  // для сравнения не используется.
  const rub = card ?? regular;
  const sku = x.sku != null ? String(x.sku) : '';
  const vat = detectVat(x);
  return {
    marketplace: 'ozon',
    id: sku,
    name: x.title || '',
    brand: typeof x.brand === 'string' ? x.brand : (x.brand && x.brand.name) || '',
    supplier: x.sellerTag || '',
    supplierId: null,
    stock: null,
    url: x.url || (sku ? `https://www.ozon.ru/product/${sku}/` : ''),
    priceKop: Number.isFinite(rub) ? rub * 100 : null,
    basicKop: Number.isFinite(card) && Number.isFinite(regular)
      ? regular * 100
      : (Number.isFinite(orig) ? orig * 100 : null),
    priceKind: Number.isFinite(card) ? 'card' : 'regular',
    priceVerified: details,
    // Розница: про НДС витрина молчит → «неизвестно», не выдумываем вычет.
    vatReturnable: vat.returnable,
    vatRate: vat.rate,
  };
}

/** Ищет явную пометку НДС в лейблах/характеристиках полной карточки. */
export function detectVat(value) {
  const strings = [];
  const visit = (node) => {
    if (typeof node === 'string') strings.push(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') Object.values(node).forEach(visit);
  };
  visit(value);

  for (const raw of strings) {
    const text = raw.toUpperCase().replace(/Ё/g, 'Е').replace(/\s+/g, ' ');
    if (/(?:БЕЗ НДС|VAT\s*FREE)/.test(text)) return { returnable: false, rate: null };
    const match = text.match(/(?:НДС|VAT)\s*[:\-]?\s*(\d{1,2})\s*%?|\b(\d{1,2})\s*%\s*(?:НДС|VAT)/);
    if (match) {
      const rate = Number(match[1] || match[2]);
      return { returnable: true, rate };
    }
  }
  return { returnable: null, rate: null };
}

export async function searchProducts(query, { maxResults = 20 } = {}) {
  if (!token()) throw new Error('PRICES_APIFY_TOKEN не задан');
  // Поиск делаем по дешёвым плиткам. Точную карточную цену дособирает enrichProducts.
  const items = await runActor({ queries: [query], maxResults, skipDetails: true });
  return (Array.isArray(items) ? items : [])
    .map((x) => toOffer(x, { details: false }))
    .filter((o) => o.id && o.name); // без названия матчить нечем
}

/** Полные цены только для уже отобранных кандидатов. */
export async function enrichProducts(offers) {
  const urls = [...new Set(offers.map((o) => o.url).filter(Boolean))];
  if (!urls.length) return offers;
  const items = await runActorAsync({ urls, skipDetails: false });
  const detailed = new Map(
    (Array.isArray(items) ? items : [])
      .map((x) => toOffer(x, { details: true }))
      .filter((o) => o.id && o.name)
      .map((o) => [o.id, o]),
  );
  return offers.map((o) => detailed.get(o.id) || o);
}

function money(decimal, formatted) {
  if (Number.isFinite(decimal)) return decimal;
  if (formatted == null) return null;
  const n = parseInt(String(formatted).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

export const adapter = {
  id: 'ozon',
  title: 'Ozon',
  enabled: () => !!token(),
  // Первый запрос — бренд+характеристики, второй обычно артикул. Это заметно
  // повышает находимость по сравнению с одним чрезмерно строгим запросом.
  maxQueries: 2,
  maxEnrich: 2,
  search: searchProducts,
  enrich: enrichProducts,
};
