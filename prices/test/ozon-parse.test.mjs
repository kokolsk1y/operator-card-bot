// Разбор composer-api — на СИНТЕТИКЕ, повторяющей вложенность Ozon:
// widgetStates → значения-JSON-строки → массив плиток со ссылкой /product/.
//
// Реального ответа Ozon с немецкого IP не получить (антибот по IP), поэтому
// тестируем ЛОГИКУ ОБХОДА и извлечения, а не точную схему. На сервере
// probe-ozon.mjs сохранит живой ответ — по нему поля цены доуточним.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOffers } from '../src/ozon-parse.mjs';

/** Плитка товара в примерном виде композера (атомы, вложенные состояния). */
function tile({ id, name, price, oldPrice, vat }) {
  const mainState = [
    { atom: { type: 'textAtom', textAtom: { text: name } } },
    { atom: { type: 'priceV2', priceV2: { price: [
      { text: `${price} ₽`, textStyle: 'PRICE' },
      ...(oldPrice ? [{ text: `${oldPrice} ₽`, textStyle: 'ORIGINAL_PRICE' }] : []),
    ] } } },
    ...(vat ? [{ atom: { type: 'labelList', labelList: { items: [{ title: `Возврат НДС ${vat}%` }] } } }] : []),
  ];
  return {
    action: { link: `/product/tovar-${id}/` },
    mainState,
    tsProductId: String(id),
  };
}

/** Ответ композера: виджеты, где значения — JSON-строки. */
function composer(tiles) {
  return {
    widgetStates: {
      'searchResultsV2-2874-default-1': JSON.stringify({ items: tiles }),
      'megaPaginator-1': JSON.stringify({ nextPage: '/business/search/?page=2' }),
    },
    layout: [{ name: 'searchResultsV2', stateId: 'searchResultsV2-2874-default-1' }],
  };
}

test('вытаскивает товары из виджетов composer-api', () => {
  const json = composer([
    tile({ id: 987654321, name: 'Лампа IEK A60 E27 11Вт 3000K груша', price: 396, oldPrice: 1800, vat: 22 }),
    tile({ id: 123456789, name: 'Розетка двойная с заземлением белая', price: 145 }),
  ]);
  const offers = extractOffers(json);
  assert.equal(offers.length, 2);

  const lamp = offers.find((o) => o.id === '987654321');
  assert.ok(lamp, 'лампа должна найтись');
  assert.equal(lamp.marketplace, 'ozon');
  assert.match(lamp.name, /Лампа IEK A60/);
  assert.equal(lamp.priceKop, 39600, 'берём цену к оплате, не перечёркнутую');
  assert.equal(lamp.basicKop, 180000);
  assert.equal(lamp.url, 'https://www.ozon.ru/product/tovar-987654321/');
});

test('бейдж «Возврат НДС 22%» распознаётся', () => {
  const [o] = extractOffers(composer([tile({ id: 111111111, name: 'Кабель ВВГ 3x2.5 100м', price: 5000, vat: 22 })]));
  assert.equal(o.vatReturnable, true);
  assert.equal(o.vatRate, 22);
});

test('без бейджа — vatReturnable неизвестен (null), не false', () => {
  // null важно: pricing.mjs посчитает по полной цене, а не «придумает» вычет.
  const [o] = extractOffers(composer([tile({ id: 222222222, name: 'Выключатель одноклавишный', price: 90 })]));
  assert.equal(o.vatReturnable, null);
  assert.equal(o.vatRate, null);
});

test('название не путается с ценой и бейджем', () => {
  const [o] = extractOffers(composer([tile({ id: 333333333, name: 'Лампа светодиодная груша E27', price: 200, vat: 22 })]));
  assert.doesNotMatch(o.name, /₽|НДС|%/);
});

test('пустой/чужой ответ → пусто, без падения', () => {
  assert.deepEqual(extractOffers({}), []);
  assert.deepEqual(extractOffers({ widgetStates: { x: 'не json' } }), []);
  assert.deepEqual(extractOffers({ widgetStates: { x: JSON.stringify({ banner: 'реклама' }) } }), []);
});

test('дедуп: один товар в двух виджетах не двоится', () => {
  const t = tile({ id: 444444444, name: 'Лампа A60 E27 11Вт', price: 300, vat: 22 });
  const json = {
    widgetStates: {
      'searchResultsV2-1': JSON.stringify({ items: [t] }),
      'skuGrid-2': JSON.stringify({ items: [t] }),
    },
  };
  assert.equal(extractOffers(json).length, 1);
});
