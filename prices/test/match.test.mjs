// Проверка движка сопоставления на РЕАЛЬНОЙ выдаче Wildberries.
//
// Запуск: node --test prices/test/
//
// Смысл теста: search.wb.ru на запрос «Лампа LED A60 E27 3000K 11Вт 990Lm IEK»
// вернул 100 товаров, среди которых нет ни одного подходящего — движок поиска
// игнорирует характеристики. Если наш матчер пропустит хоть один из них как
// совпадение, бот будет слать ложные находки, и вся затея развалится.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canon, canonArticle } from '../src/normalize.mjs';
import { extractSpecs, extractPack } from '../src/specs.mjs';
import { matchProduct } from '../src/match.mjs';

const REF = {
  name: 'Лампа LED A60 E27 3000K 11Вт 990Lm IEK',
  article: 'LLE-A60-11-230-30-E27',
  brand: 'IEK',
};

const fixture = JSON.parse(
  readFileSync(new URL('./wb-lamp-fixture.json', import.meta.url), 'utf8'),
);

test('canon сворачивает кириллические омоглифы в латиницу', () => {
  // Слева кириллические Е, К, А, В — визуально те же буквы, что справа.
  assert.equal(canon('Лампа А60 Е27 3000К 11Вт'), canon('Лампа A60 E27 3000K 11Bт'));
  assert.equal(canon('Ё'), 'E');
});

test('canonArticle не зависит от разделителей', () => {
  assert.equal(canonArticle('LLE-A60-11-230-30-E27'), canonArticle('lle a60 11 230 30 e27'));
});

test('характеристики достаются из названия в обеих раскладках', () => {
  const lat = extractSpecs('Лампа LED A60 E27 3000K 11Вт 990Lm 230В IEK');
  assert.deepEqual(lat, {
    socket: 'E27', shape: 'A60', power: 11, cct: 3000, lumens: 990, voltage: 230,
  });
  // То же название, но коды набраны кириллицей — результат обязан совпасть.
  const cyr = extractSpecs('Лампа LED А60 Е27 3000К 11Вт 990Lm 230В IEK');
  assert.deepEqual(cyr, lat);
});

test('цветовая температура понимается словами', () => {
  assert.equal(extractSpecs('Лампа E27 9Вт тёплый белый').cct, 3000);
  assert.equal(extractSpecs('Лампа E27 9Вт холодный свет').cct, 6500);
});

test('«не указано» не равно «не совпало»', () => {
  // У кандидата не написана температура — это не повод отбрасывать.
  const r = matchProduct(REF, { name: 'Лампа светодиодная A60 E27 11Вт IEK', brand: 'IEK' });
  assert.notEqual(r.verdict, 'reject');
  assert.ok(r.unknown.includes('cct'));
});

test('расхождение по мощности — отказ', () => {
  const r = matchProduct(REF, { name: 'Лампа A60 E27 3000K 10Вт IEK', brand: 'IEK' });
  assert.equal(r.verdict, 'reject');
});

test('другой бренд — отказ', () => {
  const r = matchProduct(REF, { name: 'Лампа LED A60 E27 3000K 11Вт 990Lm', brand: 'Camelion' });
  assert.equal(r.verdict, 'reject');
});

test('артикул в названии перевешивает пороги', () => {
  const r = matchProduct(REF, { name: 'Лампочка IEK LLE-A60-11-230-30-E27 в упаковке', brand: 'IEK' });
  assert.equal(r.verdict, 'match');
});

test('990 Лм и 1000 Лм — одна лампа (округление продавца)', () => {
  const r = matchProduct(REF, { name: 'Лампа LED A60 E27 3000K 11Вт 1000Лм IEK', brand: 'IEK' });
  assert.equal(r.verdict, 'match');
});

test('количество в лоте вытаскивается из названия', () => {
  assert.equal(extractPack('Лампа A60 E27 11Вт 2шт'), 2);
  assert.equal(extractPack('Лампа E27, комплект из 10'), 10);
  assert.equal(extractPack('Лампа E27 9Вт'), 1);
  // «11Вт» и «3000К» не должны читаться как количество.
  assert.equal(extractPack('Лампа LED A60 E27 3000K 11Вт 990Lm IEK'), 1);
});

test('ГЛАВНОЕ: на реальной выдаче WB матчер отсеивает мусор', () => {
  const verdicts = fixture.products.map((p) => ({ p, r: matchProduct(REF, p) }));
  const matches = verdicts.filter((v) => v.r.verdict === 'match');

  // Единственное совпадение — настоящее: A60 / E27 / 11Вт / 3000К / Iek.
  assert.equal(matches.length, 1);
  assert.match(matches[0].p.name, /A60.*11Вт.*3000К.*E27/);
  assert.equal(matches[0].p.brand, 'Iek');

  // Оно лежит на 34-й позиции выдачи — «топ-10» его бы не увидел.
  assert.ok(verdicts.indexOf(matches[0]) > 10);

  // И это связка из двух ламп: цена лота ≠ цена штуки.
  assert.equal(matches[0].r.pack, 2);

  // Подавляющее большинство — отсев, иначе бот утопит оператора в ложных находках.
  const rejected = verdicts.filter((v) => v.r.verdict === 'reject').length;
  assert.ok(rejected >= 90, `отсеяно всего ${rejected} из 100`);
});
