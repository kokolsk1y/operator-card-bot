// Проверка решения «выгодно или нет».
// Запуск: node --test prices/test/pricing.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netCost, evaluateOffer } from '../src/pricing.mjs';

// Наша закупочная 30 ₽ за штуку, без НДС.
const OUR = { priceKop: 3000, priceHasVat: false, vatRate: null };

test('без возврата НДС платим полную цену', () => {
  assert.equal(netCost(3400, false, 22), 3400);
});

test('с возвратом НДС 22% чистая цена меньше', () => {
  // 34.00 / 1.22 = 27.87
  assert.equal(netCost(3400, true, 22), 2787);
});

test('ставка берётся с витрины, а не 22 по умолчанию', () => {
  // УСН с оборотом >60 млн платит 5% — ставка не универсальна.
  assert.equal(netCost(3400, true, 5), 3238);
  assert.equal(netCost(3400, true, 10), 3091);
});

test('ГЛАВНОЕ: одна цена, разные решения — из-за возврата НДС', () => {
  const offer = { priceKop: 3400, pack: 1, vatRate: 22 };

  const withReturn = evaluateOffer({ ...offer, vatReturnable: true }, OUR);
  assert.equal(withReturn.offerNetKop, 2787);
  assert.equal(withReturn.worthIt, true, '27.87 < 30 — берём');

  const noReturn = evaluateOffer({ ...offer, vatReturnable: false }, OUR);
  assert.equal(noReturn.offerNetKop, 3400);
  assert.equal(noReturn.worthIt, false, '34.00 > 30 — это убыток');
});

test('ловушка УСН: делить на 1.22 без возврата НДС = придумать скидку', () => {
  // Продавец на УСН, НДС в цене нет. Бейджа «Возврат НДС» на карточке нет.
  const r = evaluateOffer({ priceKop: 3400, pack: 1, vatReturnable: false, vatRate: null }, OUR);
  assert.equal(r.offerNetKop, 3400, 'ни в коем случае не 2787');
  assert.equal(r.worthIt, false);
});

test('цена лота делится на количество', () => {
  // 10 ламп за 250 ₽ = 25 ₽/шт — дешевле нашей закупочной в 30 ₽.
  const r = evaluateOffer({ priceKop: 25000, pack: 10, vatReturnable: false, vatRate: null }, OUR);
  assert.equal(r.unitKop, 2500);
  assert.equal(r.worthIt, true);
  assert.match(r.why, /лот 250\.00 ₽ ÷ 10 шт/);
});

test('связка из 2 штук за 390 ₽ (реальная находка на WB) — мимо', () => {
  const r = evaluateOffer({ priceKop: 39000, pack: 2, vatReturnable: false, vatRate: null }, OUR);
  assert.equal(r.unitKop, 19500);
  assert.equal(r.worthIt, false);
});

test('наша закупочная с НДС приводится к той же базе', () => {
  const ourWithVat = { priceKop: 3660, priceHasVat: true, vatRate: 22 }; // 36.60 с НДС = 30 без
  const r = evaluateOffer({ priceKop: 3400, pack: 1, vatReturnable: true, vatRate: 22 }, ourWithVat);
  assert.equal(r.ourNetKop, 3000);
  assert.equal(r.offerNetKop, 2787);
  assert.equal(r.worthIt, true);
});

test('неизвестная цена не считается выгодной', () => {
  const r = evaluateOffer({ priceKop: null, pack: 1, vatReturnable: true, vatRate: 22 }, OUR);
  assert.equal(r.worthIt, false);
});
