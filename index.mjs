// Telegram-бот для операторов: собирает карточку товара.
// Поток: название -> бейдж(опц.) -> фото(авто-вырезка) -> до 4 характеристик -> карточка.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { renderCard } from './render.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const BG = path.join(__dirname, 'фон.png');
const TMP = path.join(__dirname, '.tmp');
const LIMIT = cfg.limits.charsPerLine;
fs.mkdirSync(TMP, { recursive: true });

const bot = new Bot(cfg.botToken);

// ── состояние диалога ───────────────────────────────────────────────────────
const S = new Map();
const STEP = { NAME: 'name', BADGE: 'badge', PHOTO: 'photo', CHAR: 'char' };
const newSession = () => ({ step: null, title: null, badge: null, cutout: '', chars: [], idx: 0, editing: null,
  offsets: {}, adjTargets: [], adjIdx: 0, adjStep: 10 });
const STEPS = [5, 10, 20];
const get = (id) => { if (!S.has(id)) S.set(id, newSession()); return S.get(id); };

// ── разбор ввода ─────────────────────────────────────────────────────────────
// заголовок: "Удлинитель / с выключателем" или просто "Удлинитель с выключателем"
function splitTitle(t) {
  t = t.trim();
  if (t.includes('/')) { const i = t.indexOf('/'); return { big: t.slice(0, i).trim(), sub: t.slice(i + 1).trim() }; }
  const m = t.match(/^(\S+)\s+([\s\S]+)$/);
  return m ? { big: m[1], sub: m[2] } : { big: t, sub: '' };
}
// характеристика: "значение / подпись / примечание"
function parseChar(t) {
  const p = t.split('/').map((s) => s.trim());
  return { big: p[0] || '', small: p[1] || '', note: p[2] || '' };
}
// проверка длины каждой части (чтобы влезло в строку)
function tooLong(t) { return t.split('/').map((s) => s.trim()).find((s) => s.length > LIMIT); }

const CHAR_PROMPTS = [
  `📊 *Главная характеристика* (в оранжевом квадрате).\nМожно в 2 строки через «/»:  \`значение / подпись\`\nНапример: \`1,5 / метра\``,
  `📋 *Характеристика №2* (полоска).\nЧерез «/»:  \`значение / подпись / примечание\`\nНапример: \`ПВС / 3х1 мм\``,
  `📋 *Характеристика №3* (полоска).\nНапример: \`10А / нагрузка / *до 2300Вт\``,
  `📋 *Характеристика №4* (полоска).\nНапример: \`3 розетки\``,
];

// ── клавиатуры ───────────────────────────────────────────────────────────────
const kbSkip = () => new InlineKeyboard().text('⏭ Пропустить', 'skip');
const kbChar = () => new InlineKeyboard().text('⏭ Пропустить', 'skip').text('✅ Собрать карточку', 'build');
const kbAfter = () => new InlineKeyboard()
  .text('🔄 Заголовок', 'edit_title').text('🖼 Фото', 'edit_photo').row()
  .text('📝 Характеристики', 'edit_chars').text('📐 Подвинуть', 'adjust').row()
  .text('🆕 Новая карточка', 'new');

// ── режим «подвинуть»: цель, клавиатура, подпись ────────────────────────────
const stripsOf = (s) => s.chars.slice(1).filter(Boolean);
function buildTargets(s) {
  const t = [{ id: 'title', label: 'Заголовок' }];
  if (s.badge) t.push({ id: 'badge', label: 'Бейдж в рамке' });
  if (s.chars[0]) t.push({ id: 'square', label: 'Оранжевый блок' });
  t.push({ id: 'group', label: 'Вся группа (оранж+хар-ки)' });
  t.push({ id: 'product', label: 'Фото товара' });
  stripsOf(s).forEach((c, i) => t.push({ id: 'char' + i, label: `Строка «${c.big}»` }));
  return t;
}
const off = (s, id) => (s.offsets[id] || (s.offsets[id] = { x: 0, y: 0 }));
function adjustKb(s) {
  const t = s.adjTargets[s.adjIdx];
  return new InlineKeyboard()
    .text('⬆️ Выше', 'a_up').text('⬇️ Ниже', 'a_dn').row()
    .text('⬅️ Левее', 'a_lf').text('➡️ Правее', 'a_rt').row()
    .text('◀', 'a_prev').text(t.label, 'a_noop').text('▶', 'a_next').row()
    .text(`Шаг: ${s.adjStep}px`, 'a_step').text('✅ Готово', 'a_done');
}
function adjCaption(s) {
  const t = s.adjTargets[s.adjIdx]; const o = off(s, t.id);
  return `📐 Двигаю: *${t.label}*\nсмещение  x:${o.x}  y:${o.y}  ·  шаг ${s.adjStep}px\n` +
    `◀ ▶ — выбрать элемент, стрелки — двигать.`;
}
function renderToFile(s, out) {
  return renderCard({
    bgPath: BG, productPath: s.cutout, title: s.title, badge: s.badge,
    mainChar: s.chars[0] || null, chars: stripsOf(s), offsets: s.offsets, outPath: out,
  });
}

// ── утилиты ──────────────────────────────────────────────────────────────────
async function downloadPhoto(ctx, dest) {
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${cfg.botToken}/${file.file_path}`;
  fs.writeFileSync(dest, Buffer.from(await (await fetch(url)).arrayBuffer()));
}
function runCutout(input, output) {
  return new Promise((resolve) => {
    const py = spawn('python', [path.join(__dirname, 'cutout.py'), input, output, cfg.model]);
    let out = '';
    py.stdout.on('data', (d) => (out += d));
    py.on('close', () => {
      const line = out.trim().split('\n').filter(Boolean).pop() || '{}';
      try { resolve(JSON.parse(line)); } catch { resolve({ status: 'fail', message: 'не удалось обработать фото' }); }
    });
  });
}

async function buildCard(ctx, s) {
  await ctx.reply('⚙️ Собираю карточку, пара секунд…');
  const out = path.join(TMP, `card_${ctx.chat.id}.png`);
  try {
    await renderToFile(s, out);
    await ctx.replyWithDocument(new InputFile(out, 'card.png'), {
      caption: '✅ Готовая карточка. Что-то поправить?', reply_markup: kbAfter(),
    });
  } catch (e) {
    await ctx.reply('⚠️ Не удалось собрать карточку: ' + e.message + '\nПопробуй /new');
  }
}

// после правки одного поля — сразу пересобрать; иначе идти дальше по шагам
function afterField(ctx, s, nextStepFn) {
  if (s.editing) { s.editing = null; s.step = null; return buildCard(ctx, s); }
  return nextStepFn();
}

const askName = (ctx, s) => { s.step = STEP.NAME;
  return ctx.reply('✍️ Шаг 1. Пришли *название товара* (станет заголовком).\n' +
    'Большое слово и подзаголовок можно разделить «/»:  `Удлинитель / с выключателем`',
    { parse_mode: 'Markdown' }); };
const askBadge = (ctx, s) => { s.step = STEP.BADGE;
  return ctx.reply('🏷 Шаг 1б. Бейдж в рамке под заголовком — *опционально*.\n' +
    'Напр.: `с заземлением`. Или жми «Пропустить».',
    { parse_mode: 'Markdown', reply_markup: kbSkip() }); };
const askPhoto = (ctx, s) => { s.step = STEP.PHOTO;
  return ctx.reply('🖼 Шаг 2. Пришли *фото товара* картинкой.\nФон уберу сам — лучше фото на простом светлом фоне.',
    { parse_mode: 'Markdown' }); };
const askChar = (ctx, s) => { s.step = STEP.CHAR;
  const extra = s.idx === 0 ? `\n\n_До 4 штук, каждая часть не длиннее ${LIMIT} символов._` : '';
  return ctx.reply(CHAR_PROMPTS[s.idx] + extra, { parse_mode: 'Markdown', reply_markup: kbChar() }); };

// ── команды ───────────────────────────────────────────────────────────────
bot.command(['start', 'new'], async (ctx) => {
  S.set(ctx.chat.id, newSession());
  await ctx.reply('👋 Привет! Я собираю карточки товаров. Сделаем новую — по шагам.');
  await askName(ctx, get(ctx.chat.id));
});

// ── текст ────────────────────────────────────────────────────────────────────
bot.on('message:text', async (ctx) => {
  const s = get(ctx.chat.id);
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  if (s.step === STEP.NAME) {
    if (!text) return ctx.reply('Название пустое — пришли текст.');
    s.title = splitTitle(text);
    return askBadge(ctx, s);   // дальше бейдж; при правке s.editing сохранится и пересоберём после бейджа
  }

  if (s.step === STEP.BADGE) {
    s.badge = text === '-' ? null : text;
    return afterField(ctx, s, () => askPhoto(ctx, s));
  }

  if (s.step === STEP.CHAR) {
    if (text === '-') { s.chars[s.idx] = null; s.idx++; }
    else {
      const bad = tooLong(text);
      if (bad) return ctx.reply(`⚠️ Слишком длинно: «${bad}» (${bad.length}/${LIMIT}) — иначе вылезет за рамку. Сократи и пришли снова.`);
      s.chars[s.idx] = parseChar(text); s.idx++;
    }
    if (s.idx >= 4) { s.step = null; return buildCard(ctx, s); }
    return askChar(ctx, s);
  }

  if (s.step === STEP.PHOTO) return ctx.reply('Жду *фото* картинкой 🙂', { parse_mode: 'Markdown' });
  return ctx.reply('Начнём? Жми /new');
});

// ── обработка фото товара (и как фото, и как файл-изображение) ───────────────
async function handleProductImage(ctx, s) {
  if (s.step !== STEP.PHOTO) return ctx.reply('Сначала /new, потом по шагам пришлёшь фото 🙂');
  const proc = await ctx.reply('⏳ Обрабатываю фото: убираю фон… (~15 сек)');
  const del = () => ctx.api.deleteMessage(ctx.chat.id, proc.message_id).catch(() => {});
  const src = path.join(TMP, `src_${ctx.chat.id}.png`);
  const cut = path.join(TMP, `cut_${ctx.chat.id}.png`);
  try { await downloadPhoto(ctx, src); }
  catch { await del(); return ctx.reply('Не смог скачать фото, пришли ещё раз.'); }
  const r = await runCutout(src, cut);
  await del();                                            // убираем «Обрабатываю…»
  if (r.status === 'fail') return ctx.reply('❌ ' + (r.message || 'не получилось') + '\nПришли другое фото.');
  s.cutout = cut;
  const note = r.status === 'warn' ? '\n⚠️ ' + r.message : '\nЕсли всё ок — жмём дальше.';
  const kb = new InlineKeyboard().text('✅ Дальше', 'photo_ok').text('🔁 Переснять', 'photo_retry');
  await ctx.replyWithPhoto(new InputFile(cut), {
    caption: '🪄 Вот товар без фона (со свечением будет на карточке).' + note, reply_markup: kb,
  });
}
bot.on('message:photo', (ctx) => handleProductImage(ctx, get(ctx.chat.id)));
bot.on('message:document', (ctx) => {
  const s = get(ctx.chat.id);
  const mime = ctx.message.document.mime_type || '';
  if (!mime.startsWith('image/')) return ctx.reply('Это не картинка 🙂 Пришли фото товара (как фото или как файл-изображение: png/jpg/webp).');
  return handleProductImage(ctx, s);
});

// ── кнопки ──────────────────────────────────────────────────────────────────
bot.on('callback_query:data', async (ctx) => {
  const s = get(ctx.chat.id);
  const d = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();

  if (d === 'new') { S.set(ctx.chat.id, newSession()); return askName(ctx, get(ctx.chat.id)); }
  if (d === 'photo_retry') return askPhoto(ctx, s);
  if (d === 'photo_ok') return afterField(ctx, s, () => { s.idx = 0; s.chars = []; return askChar(ctx, s); });
  if (d === 'build') { s.step = null; return buildCard(ctx, s); }
  if (d === 'skip') {
    if (s.step === STEP.BADGE) { s.badge = null; return afterField(ctx, s, () => askPhoto(ctx, s)); }
    s.chars[s.idx] = null; s.idx++;
    if (s.idx >= 4) { s.step = null; return buildCard(ctx, s); }
    return askChar(ctx, s);
  }
  if (d === 'edit_title') { s.editing = 'title'; return askName(ctx, s); }
  if (d === 'edit_photo') { s.editing = 'photo'; return askPhoto(ctx, s); }
  if (d === 'edit_chars') { s.editing = 'chars'; s.idx = 0; s.chars = []; return askChar(ctx, s); }

  // ── режим «подвинуть» ──
  if (d === 'adjust') {
    s.adjTargets = buildTargets(s); s.adjIdx = 0; s.adjStep = 10;
    const out = path.join(TMP, `adj_${ctx.chat.id}.png`);
    await renderToFile(s, out);
    return ctx.replyWithPhoto(new InputFile(out), { caption: adjCaption(s), parse_mode: 'Markdown', reply_markup: adjustKb(s) });
  }
  if (d === 'a_noop') return;
  if (d === 'a_prev' || d === 'a_next' || d === 'a_step') {
    const n = s.adjTargets.length;
    if (d === 'a_prev') s.adjIdx = (s.adjIdx - 1 + n) % n;
    if (d === 'a_next') s.adjIdx = (s.adjIdx + 1) % n;
    if (d === 'a_step') s.adjStep = STEPS[(STEPS.indexOf(s.adjStep) + 1) % STEPS.length];
    return ctx.editMessageCaption({ caption: adjCaption(s), parse_mode: 'Markdown', reply_markup: adjustKb(s) });
  }
  if (['a_up', 'a_dn', 'a_lf', 'a_rt'].includes(d)) {
    const o = off(s, s.adjTargets[s.adjIdx].id); const st = s.adjStep;
    if (d === 'a_up') o.y -= st; if (d === 'a_dn') o.y += st;
    if (d === 'a_lf') o.x -= st; if (d === 'a_rt') o.x += st;
    const out = path.join(TMP, `adj_${ctx.chat.id}.png`);
    await renderToFile(s, out);
    return ctx.editMessageMedia(
      { type: 'photo', media: new InputFile(out), caption: adjCaption(s), parse_mode: 'Markdown' },
      { reply_markup: adjustKb(s) });
  }
  if (d === 'a_done') {
    await ctx.editMessageCaption({ caption: '✅ Положение сохранено.' });
    return buildCard(ctx, s);
  }
});

bot.catch((err) => console.error('Bot error:', err.error?.message || err.message));
bot.start({ onStart: (i) => console.log(`✅ Бот @${i.username} запущен. Ctrl+C — стоп.`) });
