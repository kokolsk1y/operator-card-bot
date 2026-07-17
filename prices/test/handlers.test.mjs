// Прогон обработчиков без Telegram: скармливаем боту апдейты напрямую
// через handleUpdate и смотрим, какие вызовы он попытался сделать в API.
//
// Главное, что проверяем — что цепочка middleware НЕ РВЁТСЯ. В index.mjs
// генератора карточек обработчик текста стоит catch-all'ом без next(),
// и всё, зарегистрированное после него, мертво. Баг молчаливый: команда
// просто не отвечает, ошибок в логах нет. Тест ловит именно это.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from 'grammy';
import { openDb, listOurProducts } from '../src/db.mjs';
import { registerHandlers, parsePrice } from '../src/handlers.mjs';

const ME = 111; // разрешённый пользователь
const STRANGER = 999;

/** Бот с подменённым транспортом: реальных запросов нет, вызовы копятся. */
function makeBot(db, opts = {}) {
  const bot = new Bot('42:FAKE', {
    botInfo: {
      id: 42, is_bot: true, first_name: 'test', username: 'test_bot',
      can_join_groups: false, can_read_all_group_messages: false,
      supports_inline_queries: false, can_connect_to_business_account: false,
      has_main_web_app: false,
    },
  });
  const calls = [];
  bot.api.config.use(async (prev, method, payload) => {
    calls.push({ method, payload });
    if (method === 'sendMessage' || method === 'editMessageText') {
      return { ok: true, result: { message_id: calls.length, date: 0, chat: { id: ME, type: 'private' } } };
    }
    return { ok: true, result: true };
  });
  registerHandlers(bot, db, { allowedUsers: [ME], checkEveryMin: 20, ...opts });
  return { bot, calls };
}

let seq = 0;
const textUpdate = (text, from = ME) => ({
  update_id: ++seq,
  message: {
    message_id: ++seq, date: Math.floor(Date.now() / 1000),
    chat: { id: from, type: 'private' },
    from: { id: from, is_bot: false, first_name: 'u' },
    text,
    entities: text.startsWith('/')
      ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }]
      : undefined,
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

const sent = (calls) =>
  calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);

test('парсер цены', () => {
  assert.equal(parsePrice('30'), 3000);
  assert.equal(parsePrice('30.50'), 3050);
  assert.equal(parsePrice('30,50'), 3050);
  assert.equal(parsePrice('30 руб'), 3000);
  assert.equal(parsePrice('ерунда'), null);
  assert.equal(parsePrice('0'), null);
});

test('чужого не пускает и ничего ему не рассказывает', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = makeBot(db);
  await bot.handleUpdate(textUpdate('/list', STRANGER));
  assert.deepEqual(sent(calls), ['Нет доступа.']);
});

test('ГЛАВНОЕ: обработчик текста не съедает команды', async () => {
  const db = openDb(':memory:');
  let searched = 0;
  const { bot, calls } = makeBot(db, { runSearch: async () => { searched++; } });

  // Обычный текст вне диалога — бот молчит и пропускает дальше.
  await bot.handleUpdate(textUpdate('просто болтовня'));
  assert.equal(sent(calls).length, 0, 'на болтовню вне диалога отвечать не должен');

  // /find зарегистрирован ПОСЛЕ обработчика текста в цепочке middleware.
  // Если тот не вызовет next(), эта команда молча умрёт.
  await bot.handleUpdate(textUpdate('/find'));
  assert.equal(searched, 1, '/find не доехал до обработчика — цепочка оборвана');
  assert.ok(sent(calls).some((t) => /Готово/.test(t)));
});

test('полный цикл заведения товара: название → артикул → цена → НДС', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = makeBot(db);

  await bot.handleUpdate(textUpdate('/add'));
  await bot.handleUpdate(textUpdate('Лампа LED A60 E27 3000K 11Вт 990Lm IEK'));
  await bot.handleUpdate(textUpdate('LLE-A60-11-230-30-E27'));
  await bot.handleUpdate(textUpdate('30'));

  const texts = sent(calls);
  assert.ok(texts.some((t) => /Артикул производителя/.test(t)));
  assert.ok(texts.some((t) => /закупочная ЗА ШТУКУ/.test(t)));
  assert.ok(texts.some((t) => /с НДС или без/.test(t)), 'должен спросить про НДС');

  // Кнопка «Без НДС».
  await bot.handleUpdate(cbUpdate('pm:vat:0'));

  const saved = listOurProducts(db, ME);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, 'Лампа LED A60 E27 3000K 11Вт 990Lm IEK');
  assert.equal(saved[0].article, 'LLE-A60-11-230-30-E27');
  assert.equal(saved[0].price_kop, 3000);
  assert.equal(saved[0].price_has_vat, 0);
});

test('кривая цена не ломает диалог', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = makeBot(db);
  await bot.handleUpdate(textUpdate('/add'));
  await bot.handleUpdate(textUpdate('Лампа'));
  await bot.handleUpdate(textUpdate('-'));
  await bot.handleUpdate(textUpdate('дёшево'));
  assert.ok(sent(calls).some((t) => /Не понял цену/.test(t)));
  assert.equal(listOurProducts(db, ME).length, 0, 'товар не должен сохраниться');
});

test('чужие кнопки пропускаются дальше, а не перехватываются', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = makeBot(db);
  let reachedNext = false;
  bot.on('callback_query:data', () => { reachedNext = true; });
  await bot.handleUpdate(cbUpdate('adjust')); // плоский callback из index.mjs
  assert.ok(reachedNext, 'чужой callback обязан дойти до следующего обработчика');
  assert.equal(calls.length, 0);
});

test('/cancel сбрасывает диалог', async () => {
  const db = openDb(':memory:');
  const { bot, calls } = makeBot(db);
  await bot.handleUpdate(textUpdate('/add'));
  await bot.handleUpdate(textUpdate('/cancel'));
  await bot.handleUpdate(textUpdate('Лампа'));
  // После отмены текст не должен восприниматься как название.
  assert.ok(!sent(calls).some((t) => /Артикул производителя/.test(t)));
});
