// Хранилище: разовая модель, одна таблица products.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, addProduct, listProducts, getProduct, deleteProduct, recordCheck } from '../src/db.mjs';

const ME = 1, OTHER = 2;
const sample = (over = {}) => ({
  name: 'Лампа LED A60 E27 3000K 11Вт IEK', article: 'LLE-A60', brand: 'IEK',
  priceKop: 3000, priceHasVat: false, vatRate: null, ownerId: ME, ...over,
});

test('добавление и чтение товара', () => {
  const db = openDb(':memory:');
  const id = addProduct(db, sample());
  const p = getProduct(db, id, ME);
  assert.equal(p.name, 'Лампа LED A60 E27 3000K 11Вт IEK');
  assert.equal(p.price_kop, 3000);
  assert.equal(p.price_has_vat, 0);
});

test('список — только свои товары', () => {
  const db = openDb(':memory:');
  addProduct(db, sample());
  addProduct(db, sample({ name: 'Розетка', ownerId: OTHER }));
  assert.equal(listProducts(db, ME).length, 1);
  assert.equal(listProducts(db, OTHER).length, 1);
});

test('чужой товар не отдаётся по id', () => {
  const db = openDb(':memory:');
  const id = addProduct(db, sample());
  assert.ok(getProduct(db, id, ME));
  assert.equal(getProduct(db, id, OTHER), undefined);
});

test('чужой товар нельзя удалить', () => {
  const db = openDb(':memory:');
  const id = addProduct(db, sample());
  assert.equal(deleteProduct(db, id, OTHER), false);
  assert.ok(getProduct(db, id, ME), 'товар должен уцелеть');
  assert.equal(deleteProduct(db, id, ME), true);
  assert.equal(getProduct(db, id, ME), undefined);
});

test('итог последней проверки сохраняется', () => {
  const db = openDb(':memory:');
  const id = addProduct(db, sample());
  recordCheck(db, id, { found: 30, deals: 2 });
  const p = getProduct(db, id, ME);
  assert.equal(p.last_found, 30);
  assert.equal(p.last_deals, 2);
  assert.ok(p.last_checked_at);
});
