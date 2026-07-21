// Маппинг ответа актора Apify → наш Offer. Без сети (сеть — в smoke).
// Пример — реальный элемент датасета zen-studio/ozon-scraper-pro (2026-07-21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toOffer } from '../src/ozon.mjs';
import { matchProduct } from '../src/match.mjs';

const REAL = {
  sku: 3545593925,
  url: 'https://www.ozon.ru/product/lampochka-svetodiodnaya-11vt-e27-a60-3000k',
  title: 'Лампочка светодиодная 11Вт Е27 А60 3000К теплый IEK (1шт)',
  price: '221 ₽', priceDecimal: 221,
  originalPrice: '256 ₽', originalPriceDecimal: 256,
  brand: { name: null, description: 'Оригинальный товар' },
  sellerTag: null,
};

test('элемент Apify → Offer', () => {
  const o = toOffer(REAL);
  assert.equal(o.marketplace, 'ozon');
  assert.equal(o.id, '3545593925');
  assert.equal(o.name, 'Лампочка светодиодная 11Вт Е27 А60 3000К теплый IEK (1шт)');
  assert.equal(o.priceKop, 22100);   // 221 ₽ в копейках
  assert.equal(o.basicKop, 25600);
  assert.match(o.url, /ozon\.ru\/product/);
  // Розница — про НДС молчим (не выдумываем вычет).
  assert.equal(o.vatReturnable, null);
});

test('цена из строки, если нет priceDecimal', () => {
  const o = toOffer({ sku: 1, title: 'x', price: '1 199 ₽' });
  assert.equal(o.priceKop, 119900);
});

test('без sku/названия — потом отфильтруется (id/name пустые)', () => {
  const o = toOffer({ price: '100 ₽' });
  assert.equal(o.id, '');
  assert.equal(o.name, '');
});

test('реальное название Ozon матчится с нашим эталоном', () => {
  const ref = { name: 'Лампа LED A60 E27 3000K 11Вт 990Lm IEK', article: 'LLE-A60-11-230-30-E27', brand: 'IEK' };
  const r = matchProduct(ref, toOffer(REAL));
  // А60/Е27/11Вт/3000К/IEK — кириллица свернётся, характеристики сойдутся.
  assert.notEqual(r.verdict, 'reject');
  assert.ok(r.matched.includes('power') && r.matched.includes('socket'));
});
