// Построитель запросов и синонимы формы — то, что чинит находимость.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueries } from '../src/queries.mjs';
import { extractSpecs, shapeFamily } from '../src/specs.mjs';
import { matchProduct } from '../src/match.mjs';

const REF = { name: 'Лампа LED A60 E27 3000K 11Вт 990Lm IEK', article: 'LLE-A60-11-230-30-E27', brand: 'IEK' };

test('несколько коротких запросов вместо одного длинного', () => {
  const qs = buildQueries(REF);
  // Полное имя WB не любит (вернул 1 товар) — его в наборе быть НЕ должно.
  assert.ok(!qs.includes(REF.name), 'длинное имя не должно попадать в запросы');
  // Артикул — обязательно.
  assert.ok(qs.includes('LLE-A60-11-230-30-E27'));
  // Бренд+характеристики — компактный запрос.
  assert.ok(qs.some((q) => /IEK/.test(q) && /A60/.test(q) && /11Вт/.test(q)));
  assert.ok(qs.length >= 2 && qs.length <= 4, `ожидал 2-4 запроса, вышло ${qs.length}`);
});

test('без бренда и артикула — фолбэк на название', () => {
  const qs = buildQueries({ name: 'Какой-то нестандартный товар без характеристик' });
  assert.equal(qs.length, 1);
});

test('запросы уникальны', () => {
  const qs = buildQueries(REF);
  assert.equal(qs.length, new Set(qs.map((q) => q.toLowerCase())).size);
});

/* ---- синонимы формы ---- */

test('«груша» распознаётся как форма A', () => {
  assert.equal(extractSpecs('Лампа груша E27 11Вт').shape, 'A-ГРУША');
  assert.equal(extractSpecs('Светодиодная свеча E14 7Вт').shape, 'C-СВЕЧА');
  assert.equal(extractSpecs('Лампа шар G45 E27').shape, 'G45'); // точный код важнее слова
});

test('A60 и «груша» — совпадают по семейству', () => {
  // Реальный кейс с WB: «Лампочка груша ... E27 11Вт 3000К» без кода A60.
  const cand = { name: 'Лампочка груша светодиодная E27 11Вт 3000К IEK', brand: 'IEK' };
  const r = matchProduct(REF, cand);
  assert.notEqual(r.verdict, 'reject', 'груша не должна отвергаться при эталоне A60');
  assert.ok(r.matched.includes('shape'), 'форма должна засчитаться как совпавшая');
});

test('«груша» не совпадает со «свечой»', () => {
  const cand = { name: 'Лампа свеча E27 11Вт 3000К IEK', brand: 'IEK' };
  const r = matchProduct(REF, cand);
  assert.ok(r.contradicted.some((c) => c.startsWith('shape')), 'форма должна противоречить');
  assert.equal(r.verdict, 'reject');
});

test('точные размеры не смешиваются: A60 != A65', () => {
  assert.equal(shapeFamily('A60'), 'A-ГРУША');
  const cand = { name: 'Лампа A65 E27 11Вт 3000К IEK', brand: 'IEK' };
  const r = matchProduct(REF, cand);
  assert.ok(r.contradicted.some((c) => c.startsWith('shape')), 'A60 и A65 — разные');
});
