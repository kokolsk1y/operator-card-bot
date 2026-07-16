// Проверка хранилища: полный путь товара от заведения до истории цен.
// Запуск: node --test prices/test/db.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, addOurProduct, listOurProducts, upsertCandidate, pendingCandidates,
  confirmCandidate, rejectCandidate, activeWatched, recordPrice, priceHistory,
} from '../src/db.mjs';

const OWNER = 111;

function seed() {
  const db = openDb(':memory:');
  const id = addOurProduct(db, {
    name: 'Лампа LED A60 E27 3000K 11Вт 990Lm IEK',
    article: 'LLE-A60-11-230-30-E27',
    brand: 'IEK',
    priceKop: 3000,
    ownerId: OWNER,
  });
  return { db, id };
}

const cand = (ourProductId, over = {}) => ({
  ourProductId, marketplace: 'wb', externalId: '231056588',
  name: 'Лампа светодиодная A60 груша 11Вт 230В 3000К E27 2шт',
  brand: 'Iek', supplier: 'Склад Электрика', pack: 2, priceKop: 39000,
  confidence: 1, reason: 'совпали: socket, shape, power, cct', ...over,
});

test('товар заводится и читается своим владельцем', () => {
  const { db, id } = seed();
  const list = listOurProducts(db, OWNER);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].price_kop, 3000);
  // Чужой пользователь чужого товара не видит.
  assert.equal(listOurProducts(db, 999).length, 0);
});

test('повторная находка не плодит дублей, а обновляет цену', () => {
  const { db, id } = seed();
  upsertCandidate(db, cand(id));
  upsertCandidate(db, cand(id, { priceKop: 35000 }));
  const p = pendingCandidates(db, id);
  assert.equal(p.length, 1);
  assert.equal(p[0].price_kop, 35000);
});

test('подтверждение переводит кандидата в отслеживание', () => {
  const { db, id } = seed();
  upsertCandidate(db, cand(id));
  const c = pendingCandidates(db, id)[0];

  confirmCandidate(db, c.id, OWNER);

  assert.equal(pendingCandidates(db, id).length, 0, 'кандидат должен уйти из ожидания');
  const w = activeWatched(db, 'wb');
  assert.equal(w.length, 1);
  assert.equal(w[0].external_id, '231056588');
  assert.equal(w[0].pack, 2, 'количество в лоте обязано доехать до отслеживания');
});

test('отклонённый кандидат не попадает в отслеживание', () => {
  const { db, id } = seed();
  upsertCandidate(db, cand(id));
  rejectCandidate(db, pendingCandidates(db, id)[0].id);
  assert.equal(pendingCandidates(db, id).length, 0);
  assert.equal(activeWatched(db).length, 0);
});

test('история пишется только при изменении цены', () => {
  const { db, id } = seed();
  upsertCandidate(db, cand(id));
  confirmCandidate(db, pendingCandidates(db, id)[0].id, OWNER);
  const w = activeWatched(db)[0];

  const first = recordPrice(db, w.id, { priceKop: 39000, stock: 53, pack: 2 });
  assert.equal(first.changed, true, 'первый замер — всегда изменение');

  // Три проверки подряд с той же ценой не должны раздувать историю.
  recordPrice(db, w.id, { priceKop: 39000, stock: 53, pack: 2 });
  recordPrice(db, w.id, { priceKop: 39000, stock: 50, pack: 2 });
  assert.equal(priceHistory(db, w.id).length, 1);

  const drop = recordPrice(db, w.id, { priceKop: 5000, stock: 50, pack: 2 });
  assert.equal(drop.changed, true);
  assert.equal(drop.prevKop, 39000);

  const h = priceHistory(db, w.id);
  assert.equal(h.length, 2);
  // Цена за штуку = цена лота / количество. 50 руб за 2 шт → 25 руб/шт.
  assert.equal(h[0].unit_price_kop, 2500);
});

test('удаление товара уносит за собой кандидатов и историю', () => {
  const { db, id } = seed();
  upsertCandidate(db, cand(id));
  confirmCandidate(db, pendingCandidates(db, id)[0].id, OWNER);
  recordPrice(db, activeWatched(db)[0].id, { priceKop: 39000, stock: 1, pack: 2 });

  db.prepare('DELETE FROM our_products WHERE id = ?').run(id);

  assert.equal(activeWatched(db).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM price_history').get().n, 0,
    'висячая история цен без товара — мусор в БД');
});
