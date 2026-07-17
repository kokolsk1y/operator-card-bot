// Поиск кандидатов: площадка → отсев → кандидаты в БД.
//
// Это ДОРОГАЯ и РЕДКАЯ операция. Поиск у маркетплейсов мусорный (WB на запрос
// про конкретную лампу выдал 100 товаров, где верный был один и стоял 34-м),
// а лимиты жёсткие (429 на 4-м запросе подряд). Поэтому гоняем раз в сутки
// и обязательно через matchProduct.

import { enabledMarketplaces } from './marketplaces.mjs';
import { matchProduct } from './match.mjs';
import { upsertCandidate } from './db.mjs';

/**
 * Сколько «под вопросом» показывать сверх точных совпадений.
 * Без ограничения человек утонет: unsure — это «характеристики не указаны»,
 * таких в выдаче много и почти все — мимо.
 */
const MAX_UNSURE = 3;

/**
 * Ищет кандидатов для одного нашего товара по всем включённым площадкам.
 * Возвращает то, что стоит показать человеку (в порядке уверенности).
 */
export async function findCandidatesFor(db, ourProduct) {
  const ref = {
    name: ourProduct.name,
    article: ourProduct.article,
    brand: ourProduct.brand,
  };

  const found = [];

  for (const mp of enabledMarketplaces()) {
    let offers;
    try {
      offers = await mp.search(ourProduct.name);
    } catch (e) {
      // Одна площадка легла — не роняем остальные.
      console.error(`поиск на ${mp.id} не удался: ${e.message}`);
      continue;
    }

    for (const offer of offers) {
      const m = matchProduct(ref, offer);
      if (m.verdict === 'reject') continue;
      found.push({ offer, m, mp: mp.id });
    }
  }

  found.sort((a, b) => b.m.confidence - a.m.confidence);

  const matches = found.filter((f) => f.m.verdict === 'match');
  const unsure = found.filter((f) => f.m.verdict === 'unsure').slice(0, MAX_UNSURE);
  const show = [...matches, ...unsure];

  for (const { offer, m } of show) {
    upsertCandidate(db, {
      ourProductId: ourProduct.id,
      marketplace: offer.marketplace,
      externalId: offer.id,
      name: offer.name,
      brand: offer.brand,
      supplier: offer.supplier,
      url: offer.url,
      pack: m.pack,
      priceKop: offer.priceKop,
      confidence: m.confidence,
      reason: m.reason,
    });
  }

  return {
    shown: show.length,
    matched: matches.length,
    unsure: unsure.length,
    rejected: found.length - show.length,
  };
}
