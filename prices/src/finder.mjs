// Разовый поиск товара по всем площадкам.
//
// Модель простая, как и просил заказчик: заполнил товар → нашли → выдали
// список дешевле твоей цены. Никакого отслеживания и подтверждений —
// ручная проверка это клики по ссылкам в выдаче.
//
// Находимость держится на мульти-запросе (queries.mjs): один длинный запрос
// возвращает почти пусто, несколько коротких — десятки совпадений.

import { enabledMarketplaces } from './marketplaces.mjs';
import { matchProduct } from './match.mjs';
import { buildQueries } from './queries.mjs';
import { evaluateOffer } from './pricing.mjs';

/**
 * Ищет предложения для одного товара по всем включённым площадкам.
 *
 * @param {{name,article,brand,price_kop,price_has_vat,vat_rate}} product
 * @returns {Promise<{results:Array, stats:object}>}
 *   results — отсортированы: сначала выгодные, потом по цене за штуку.
 *   Каждый элемент: {offer, match, deal}.
 */
export async function searchProduct(product) {
  const ref = { name: product.name, article: product.article, brand: product.brand };
  const queries = buildQueries(product);

  // id -> {offer, match} — дедуп по товару, оставляем лучшее совпадение.
  const pool = new Map();

  for (const mp of enabledMarketplaces()) {
    // Платные площадки (Ozon через Apify) ограничивают число запросов на товар,
    // чтобы не жечь кредит. WB бесплатный — гоняет все запросы.
    const mpQueries = queries.slice(0, mp.maxQueries ?? queries.length);
    for (const q of mpQueries) {
      let offers;
      try {
        offers = await mp.search(q);
      } catch (e) {
        console.error(`${mp.id} «${q}»: ${e.message}`);
        continue;
      }
      for (const offer of offers) {
        const match = matchProduct(ref, offer);
        if (match.verdict === 'reject') continue;
        const key = `${offer.marketplace}:${offer.id}`;
        const prev = pool.get(key);
        if (!prev || match.confidence > prev.match.confidence) pool.set(key, { offer, match });
      }
    }
  }

  const our = {
    priceKop: product.price_kop,
    priceHasVat: !!product.price_has_vat,
    vatRate: product.vat_rate,
  };

  const results = [...pool.values()].map(({ offer, match }) => {
    const deal = evaluateOffer(
      { priceKop: offer.priceKop, pack: match.pack, vatReturnable: offer.vatReturnable, vatRate: offer.vatRate },
      our,
    );
    return { offer, match, deal };
  });

  // Сортировка: выгодные вперёд, внутри — по цене за штуку, затем по уверенности.
  results.sort((a, b) => {
    if (a.deal.worthIt !== b.deal.worthIt) return a.deal.worthIt ? -1 : 1;
    const ua = a.deal.unitKop ?? Infinity;
    const ub = b.deal.unitKop ?? Infinity;
    if (ua !== ub) return ua - ub;
    return b.match.confidence - a.match.confidence;
  });

  const stats = {
    queries: queries.length,
    found: pool.size,
    deals: results.filter((r) => r.deal.worthIt).length,
    matches: results.filter((r) => r.match.verdict === 'match').length,
  };

  return { results, stats };
}
