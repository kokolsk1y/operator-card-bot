// Прогон обработчиков без Telegram и без сети: апдейты скармливаем боту через
// handleUpdate, поиск подменяем заглушкой (searchFn). Смотрим, что бот вызвал.
//
// Главное — цепочка middleware не рвётся: обработчик текста без next() убил бы
// команды после себя (ровно этот баг в index.mjs генератора карточек).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from 'grammy';
import { openDb, listProducts, addProduct } from '../src/db.mjs';
import { registerHandlers, parsePrice, parseProductBlock } from '../src/handlers.mjs';

const ME = 111, STRANGER = 999;

/** Заглушка поиска: ничего не находит, но фиксирует, по какому товару звали. */
const fakeSearch = (calls) => async (product) => {
  calls.push(product.id);
  return { results: [], stats: { queries: 2, found: 0, deals: 0, matches: 0 } };
};

function makeBot(db, opts = {}) {
  const bot = new Bot('42:FAKE', {
    botInfo: {
      id: 42, is_bot: true, first_name: 't', username: 't_bot',
      can_join_groups: false, can_read_all_group_messages: false,
      supports_inline_queries: false, can_connect_to_business_account: false,
      has_main_web_app: false,
    },
  });
  const calls = [];
  const searched = [];
  bot.api.config.use(async (prev, method, payload) => {
    calls.push({ method, payload });
    if (method === 'sendMessage' || method === 'editMessageText') {
      return { ok: true, result: { message_id: calls.length, date: 0, chat: { id: ME, type: 'private' } } };
    }
    return { ok: true, result: true };
  });
  registerHandlers(bot, db, { allowedUsers: [], searchFn: fakeSearch(searched), ...opts });
  return { bot, calls, searched };
}

let seq = 0;
const textUpdate = (text, from = ME) => ({
  update_id: ++seq,
  message: {
    message_id: ++seq, date: Math.floor(Date.now() / 1000),
    chat: { id: from, type: 'private' },
    from: { id: from, is_bot: false, first_name: 'u' },
    text,
    // Длина команды = только «/add», даже если дальше идёт перенос строки.
    entities: /^\/[A-Za-z_]+/.test(text)
      ? [{ type: 'bot_command', offset: 0, length: text.match(/^\/[A-Za-z_]+/)[0].length }] : undefined,
  },
});
const cbUpdate = (data, from = ME) => ({
  update_id: ++seq,
  callback_query: {
    id: String(++seq), from: { id: from, is_bot: false, first_name: 'u' },
    chat_instance: '1', data,
    message: {
      message_id: ++seq, date: 0, chat: { id: from, type: 'private' },
      from: { id: 42, is_bot: true, first_name: 'b' }, text: 'x',
    },
  },
});
const sent = (calls) => calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);

test('парсер цены', () => {
  assert.equal(parsePrice('30'), 3000);
  assert.equal(parsePrice('30,50'), 3050);
  assert.equal(parsePrice('ерунда'), null);
  assert.equal(parsePrice('0'), null);
});

test('разбор многострочной вставки: название / артикул / цена', () => {
  const r = parseProductBlock('Лампа LED A60 E27 3000K 11Вт IEK\nLLE-A60-11-230-30-E27\n30');
  assert.equal(r.name, 'Лампа LED A60 E27 3000K 11Вт IEK');
  assert.equal(r.article, 'LLE-A60-11-230-30-E27');
  assert.equal(r.priceKop, 3000);
});

test('разбор пачки: только название', () => {
  const r = parseProductBlock('Розетка двойная белая');
  assert.equal(r.name, 'Розетка двойная белая');
  assert.equal(r.article, null);
  assert.equal(r.priceKop, null);
});

test('разбор пачки: цена с «руб»', () => {
  assert.equal(parseProductBlock('Лампа\n45 руб').priceKop, 4500);
});

test('ГЛАВНОЕ: /add с пачкой одним сообщением → сразу поиск', async () => {
  // Ровно то, что сделал пользователь: всё в одном сообщении с /add.
  const db = openDb(':memory:');
  const { bot, searched } = makeBot(db);
  await bot.handleUpdate(textUpdate('/add\nЛампа LED A60 E27 3000K 11Вт IEK\nLLE-A60-11-230-30-E27\n30'));
  const saved = listProducts(db, ME);
  assert.equal(saved.length, 1, 'товар должен завестись из одного сообщения');
  assert.equal(saved[0].article, 'LLE-A60-11-230-30-E27');
  assert.equal(saved[0].price_kop, 3000);
  assert.deepEqual(searched, [saved[0].id], 'должен сразу искать');
});

test('пачка без цены: спрашивает недостающее', async () => {
  const db = openDb(':memory:');
  const { bot, calls, searched } = makeBot(db);
  await bot.handleUpdate(textUpdate('/add\nЛампа A60 E27 11Вт\nLLE-A60-11'));
  // Название и артикул есть, цены нет — спросит цену, товар пока не заведён.
  assert.ok(sent(calls).some((t) => /закупочная цена/i.test(t)));
  assert.equal(listProducts(db, ME).length, 0);
  assert.equal(searched.length, 0);
});

test('ГЛАВНОЕ: обработчик текста не съедает команды', async () => {
  const db = openDb(':memory:');
  addProduct(db, { name: 'Лампа', priceKop: 3000, ownerId: ME });
  const { bot, searched } = makeBot(db);
  // Болтовня вне диалога — молчим и пропускаем дальше.
  await bot.handleUpdate(textUpdate('просто текст'));
  // /check зарегистрирован ПОСЛЕ обработчика текста — доехать обязан.
  await bot.handleUpdate(textUpdate('/check'));
  assert.deepEqual(searched, [1], '/check не доехал — цепочка оборвана');
});

test('полный цикл /add → сразу поиск', async () => {
  const db = openDb(':memory:');
  const { bot, calls, searched } = makeBot(db);
  await bot.handleUpdate(textUpdate('/add'));
  await bot.handleUpdate(textUpdate('Лампа LED A60 E27 3000K 11Вт 990Lm IEK'));
  await bot.handleUpdate(textUpdate('LLE-A60-11-230-30-E27'));
  await bot.handleUpdate(textUpdate('30'));

  const saved = listProducts(db, ME);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].price_kop, 3000);
  assert.equal(saved[0].article, 'LLE-A60-11-230-30-E27');
  assert.deepEqual(searched, [saved[0].id], 'после сохранения должен сразу искать');
});

test('кнопка «Пропустить» на артикуле', async () => {
  const db = openDb(':memory:');
  const { bot } = makeBot(db);
  await bot.handleUpdate(textUpdate('/add'));
  await bot.handleUpdate(textUpdate('Розетка двойная'));
  await bot.handleUpdate(cbUpdate('pm:noart'));
  await bot.handleUpdate(textUpdate('45'));
  const saved = listProducts(db, ME);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].article, null);
});

test('кривая цена не ломает диалог', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = makeBot(db);
  await bot.handleUpdate(textUpdate('/add'));
  await bot.handleUpdate(textUpdate('Лампа'));
  await bot.handleUpdate(textUpdate('-'));
  await bot.handleUpdate(textUpdate('дёшево'));
  assert.ok(sent(calls).some((t) => /Не понял цену/.test(t)));
  assert.equal(listProducts(db, ME).length, 0);
});

test('кнопка «Проверить» ищет свой товар', async () => {
  const db = openDb(':memory:');
  const id = addProduct(db, { name: 'Лампа', priceKop: 3000, ownerId: ME });
  const { bot, searched } = makeBot(db);
  await bot.handleUpdate(cbUpdate(`pm:check:${id}`));
  assert.deepEqual(searched, [id]);
});

test('чужой товар нельзя проверить и удалить', async () => {
  const db = openDb(':memory:');
  const id = addProduct(db, { name: 'Секрет компании', priceKop: 5000, ownerId: ME });
  const { bot, searched } = makeBot(db);
  await bot.handleUpdate(cbUpdate(`pm:check:${id}`, STRANGER));
  assert.deepEqual(searched, [], 'чужой поиск не должен запуститься');
  await bot.handleUpdate(cbUpdate(`pm:del:${id}`, STRANGER));
  assert.ok(listProducts(db, ME).length === 1, 'чужой товар должен уцелеть');
});

test('чужие кнопки пропускаются дальше', async () => {
  const db = openDb(':memory:');
  const { bot } = makeBot(db);
  let reached = false;
  bot.on('callback_query:data', () => { reached = true; });
  await bot.handleUpdate(cbUpdate('adjust')); // плоский callback из index.mjs
  assert.ok(reached);
});

test('в открытом режиме /list показывает только своё', async () => {
  const db = openDb(':memory:');
  addProduct(db, { name: 'Мой товар', priceKop: 3000, ownerId: ME });
  addProduct(db, { name: 'ЧУЖОЙ СЕКРЕТ', priceKop: 9000, ownerId: STRANGER });
  const { bot, calls } = makeBot(db);
  await bot.handleUpdate(textUpdate('/list', ME));
  const all = sent(calls).join('\n');
  assert.ok(/Мой товар/.test(all));
  assert.ok(!/ЧУЖОЙ СЕКРЕТ/.test(all), 'чужой товар утёк в /list!');
});
