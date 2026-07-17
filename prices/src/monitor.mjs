// Проверка цен по списку отслеживания — ДЕШЁВАЯ и ЧАСТАЯ операция.
//
// Здесь никакого поиска и угадывания: товар уже подтверждён человеком, у него
// есть постоянный ID. Цены берутся пачками (WB отдаёт 60 штук за один запрос),
// поэтому 500 позиций — это 9 обращений, а не 500.
//
// Почему часто: цена той же лампы за час менялась с 63 ₽ до 80 ₽ (+27%).
// Ошибочные цены живут минуты, «раз в день» их гарантированно проспит.

import { activeWatched, recordPrice, getOurProduct } from './db.mjs';
import { enabledMarketplaces } from './marketplaces.mjs';
import { evaluateOffer } from './pricing.mjs';

/**
 * Обходит все площадки, обновляет цены, зовёт onDeal для новых выгодных.
 *
 * @param {Function} onDeal ({ourProduct, watched, offer, verdict}) => Promise
 * @returns {{checked:number, changed:number, deals:number}}
 */
export async function checkPrices(db, onDeal) {
  let checked = 0, changed = 0, deals = 0;

  for (const mp of enabledMarketplaces()) {
    const watched = activeWatched(db, mp.id);
    if (!watched.length) continue;

    let prices;
    try {
      prices = await mp.prices(watched.map((w) => w.external_id));
    } catch (e) {
      console.error(`цены с ${mp.id} не пришли: ${e.message}`);
      continue;
    }

    for (const w of watched) {
      const offer = prices.get(String(w.external_id));
      if (!offer) {
        // Товар пропал с витрины — не ошибка, бывает: сняли с продажи.
        recordPrice(db, w.id, { priceKop: null, stock: null, pack: w.pack });
        continue;
      }
      checked++;

      const { changed: didChange } = recordPrice(db, w.id, {
        priceKop: offer.priceKop, stock: offer.stock, pack: w.pack,
      });
      if (!didChange) continue; // цена та же — молчим, иначе спам
      changed++;

      const our = getOurProduct(db, w.our_product_id);
      if (!our || !our.active) continue;

      const verdict = evaluateOffer(
        {
          priceKop: offer.priceKop,
          pack: w.pack,
          vatReturnable: offer.vatReturnable,
          vatRate: offer.vatRate,
        },
        {
          priceKop: our.price_kop,
          priceHasVat: !!our.price_has_vat,
          vatRate: our.vat_rate,
        },
      );

      if (!verdict.worthIt) continue;
      deals++;
      await onDeal({ ourProduct: our, watched: w, offer, verdict });
    }
  }

  return { checked, changed, deals };
}
