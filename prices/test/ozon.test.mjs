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

test('актуальная плитка Apify: бренд строкой не теряется', () => {
  const o = toOffer({
    sku: 1185261285,
    title: 'Apple Смартфон iPhone 15 SIM+eSIM 128 ГБ',
    price: '62 334 ₽',
    priceDecimal: 62334,
    originalPriceDecimal: 84999,
    brand: 'Apple',
    sellerTag: 'Ozon',
    url: 'https://www.ozon.ru/product/1185261285/',
  });
  assert.equal(o.brand, 'Apple');
  assert.equal(o.priceKop, 6_233_400);
  assert.equal(o.basicKop, 8_499_900);
  assert.equal(o.priceKind, 'regular');
  assert.equal(o.priceVerified, false);
});

test('полная карточка Ozon: берём более низкую цену по карте/акции', () => {
  const o = toOffer({
    sku: 123,
    title: 'MVA20-1-016-B Выключатель (комплект 12 шт.)',
    cardPrice: '2 509 ₽',
    cardPriceDecimal: 2509,
    price: '2 788 ₽',
    priceDecimal: 2788,
    originalPrice: '4 266 ₽',
    originalPriceDecimal: 4266,
  }, { details: true });
  assert.equal(o.priceKop, 250_900);
  assert.equal(o.basicKop, 278_800);
  assert.equal(o.priceKind, 'card');
  assert.equal(o.priceVerified, true);
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
