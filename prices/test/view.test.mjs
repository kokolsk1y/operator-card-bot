import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSearch } from '../src/view.mjs';

const product = { name: 'Тестовый товар', price_kop: 30_000 };
const baseOffer = {
  marketplace: 'ozon', id: '1', name: 'Тестовый товар', supplier: '',
  url: 'https://www.ozon.ru/product/1/', priceKop: 25_000, priceVerified: true,
};
const match = { pack: 1 };

test('выдача разделяет подтверждённый НДС 22% и ручную проверку', () => {
  const confirmed = {
    offer: { ...baseOffer, id: '1' }, match,
    deal: { unitKop: 25_000, worthIt: true, needsVatCheck: false, vatStatus: 'confirmed22' },
  };
  const unknown = {
    offer: { ...baseOffer, id: '2', url: 'https://www.ozon.ru/product/2/' }, match,
    deal: { unitKop: 25_000, worthIt: false, needsVatCheck: true, vatStatus: 'unknown' },
  };
  const text = renderSearch(product, { results: [confirmed, unknown] });
  assert.match(text, /подтверждён НДС 22%/i);
  assert.match(text, /НДС 22% проверить вручную/i);
  assert.match(text, /✅ НДС 22%/);
  assert.match(text, /⚠️ НДС проверить вручную/);
});
