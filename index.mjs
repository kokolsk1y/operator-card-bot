// Telegram-бот для операторов: собирает карточку товара.
// Поток: название -> бейдж(опц.) -> фото(авто-вырезка) -> до 4 характеристик -> карточка.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bot, InlineKeyboard, InputFile } from 'grammy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const BG = path.join(__dirname, 'фон.png');
const EXAMPLE = path.join(__dirname, 'пример карточки.png');   // эталон для показа оператору
const TMP = path.join(__dirname, '.tmp');                  // внутреннее (job-файлы, превью сдвига)
const DIR_UP = path.join(__dirname, 'загруженные фото');   // что прислал оператор
const DIR_CUT = path.join(__dirname, 'без фона');          // вырезанный товар
const DIR_CARD = path.join(__dirname, 'готовые карточки'); // итоговые карточки
const LIMIT = cfg.limits.charsPerLine;
[TMP, DIR_UP, DIR_CUT, DIR_CARD].forEach((d) => fs.mkdirSync(d, { recursive: true }));
const pad2 = (n) => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`; };

const bot = new Bot(cfg.botToken);

// ── состояние диалога ───────────────────────────────────────────────────────
const S = new Map();
const STEP = { NAME: 'name', BADGE: 'badge', PHOTO: 'photo', CHAR: 'char' };
const newSession = () => ({ step: null, title: null, badge: null, cutout: '', cutStatus: null, cutPromise: null,
  chars: [], idx: 0, editing: null, offsets: {}, adjTargets: [], adjIdx: 0, adjStep: 10 });
const STEPS = [5, 10, 20];
const get = (id) => { if (!S.has(id)) S.set(id, newSession()); return S.get(id); };

// ── разбор ввода ─────────────────────────────────────────────────────────────
// Разделитель строк — «^» ИЛИ перенос строки. «/» больше НЕ разделяет (данные «16/250 В» не ломаются).
const SEP = /\s*\^\s*|\r?\n/;
const splitParts = (t) => t.split(SEP).map((s) => s.trim());
// заголовок: "Удлинитель ^ с выключателем" / с новой строки / или "Удлинитель с выключателем"
function splitTitle(t) {
  t = t.trim();
  const p = splitParts(t).filter(Boolean);
  if (p.length >= 2) return { big: p[0], sub: p.slice(1).join(' ') };
  const m = t.match(/^(\S+)\s+([\s\S]+)$/);     // нет разделителя — 1-е слово большое, остальное подзаголовок
  return m ? { big: m[1], sub: m[2] } : { big: t, sub: '' };
}
// характеристика: "значение ^ подпись ^ примечание"
function parseChar(t) {
  const p = splitParts(t);
  return { big: p[0] || '', small: p[1] || '', note: p[2] || '' };
}
// проверка длины каждой части (чтобы влезло в строку)
function tooLong(t) { return splitParts(t).find((s) => s.length > LIMIT); }

const CHAR_PROMPTS = [
  `📊 *Главная характеристика* (в оранжевом квадрате).\nДве строки — через «^» или с новой строки:\n\`1,5 ^ метра\`\n_Если характеристики не нужны — жми «Пропустить», тогда фото встанет по центру._`,
  `📋 *Характеристика №2* (полоска).\nЗначение ^ подпись ^ примечание:\n\`ПВС ^ 3х1 мм\``,
  `📋 *Характеристика №3* (полоска).\nНапример: \`10А ^ нагрузка ^ *до 2300Вт\``,
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
// рендер — в ОТДЕЛЬНОМ процессе (render-worker.mjs). Падение рендера не убьёт бота.
function renderToFile(s, out) {
  return new Promise((resolve, reject) => {
    const job = {
      bgPath: BG, productPath: s.cutout, title: s.title, badge: s.badge,
      mainChar: s.chars[0] || null, chars: stripsOf(s), offsets: s.offsets, outPath: out,
    };
    try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}   // убрать старую карточку
    const jobPath = out.replace(/\.png$/, '') + '.job.json';
    fs.writeFileSync(jobPath, JSON.stringify(job));
    const child = spawn('node', [path.join(__dirname, 'render-worker.mjs'), jobPath], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error('не удалось запустить рендер: ' + e.message)));
    child.on('close', () => {
      try { fs.unlinkSync(jobPath); } catch {}
      // успех = карточка записана (даже если воркер упал на закрытии chromium)
      if (fs.existsSync(out)) resolve(out);
      else reject(new Error('рендер не удался' + (err ? ': ' + err.slice(0, 300) : '')));
    });
  });
}

// ── утилиты ──────────────────────────────────────────────────────────────────
// скачивает фото в «загруженные фото/<chatid>.<ext>», возвращает путь
async function downloadPhoto(ctx, destNoExt) {
  const file = await ctx.getFile();
  const ext = (String(file.file_path).match(/\.(\w+)$/)?.[1] || 'jpg').toLowerCase();
  const base = path.basename(destNoExt);
  for (const f of fs.readdirSync(path.dirname(destNoExt))) {        // убрать прежнюю загрузку этого чата
    if (f.startsWith(base + '.')) { try { fs.unlinkSync(path.join(path.dirname(destNoExt), f)); } catch {} }
  }
  const dest = destNoExt + '.' + ext;
  const url = `https://api.telegram.org/file/bot${cfg.botToken}/${file.file_path}`;
  fs.writeFileSync(dest, Buffer.from(await (await fetch(url)).arrayBuffer()));
  return dest;
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
  // дождаться фоновой вырезки фона, если ещё идёт
  if (s.cutStatus === 'pending' && s.cutPromise) {
    await ctx.reply('⏳ Ещё убираю фон, пара секунд…');
    try { await s.cutPromise; } catch {}
  }
  if (!s.cutout || s.cutStatus === 'fail') {
    return ctx.reply('⚠️ Нет готового фото товара. Пришли фото товара и попробуй снова.');
  }
  await ctx.reply('⚙️ Собираю карточку, пара секунд…');
  const out = path.join(DIR_CARD, `${ctx.chat.id}_${stamp()}.png`);
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
  return ctx.reply('✍️ Шаг 1. Пришли *название товара* (станет заголовком по центру).\n' +
    'Большое слово и подзаголовок раздели «^» или новой строкой:  `Удлинитель ^ с выключателем`',
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
async function startNew(ctx, showExample) {
  S.set(ctx.chat.id, newSession());
  if (showExample) {
    await ctx.replyWithPhoto(new InputFile(EXAMPLE), {
      caption: '👋 Привет! Я собираю карточки товаров.\n\n👆 Вот так должна выглядеть готовая карточка — к этому идём. Сейчас сделаем по шагам.',
    }).catch(() => {});
  }
  await askName(ctx, get(ctx.chat.id));
}
bot.command('start', (ctx) => startNew(ctx, true));   // /start — с примером
bot.command('new', (ctx) => startNew(ctx, false));    // /new — без примера

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
// Вырезка фона идёт В ФОНЕ — оператор сразу пишет дальше, результат прилетит позже.
async function handleProductImage(ctx, s) {
  if (s.step !== STEP.PHOTO) return ctx.reply('Сначала /new, потом по шагам пришлёшь фото 🙂');
  let src;
  try { src = await downloadPhoto(ctx, path.join(DIR_UP, String(ctx.chat.id))); }
  catch { return ctx.reply('Не смог скачать фото, пришли ещё раз.'); }
  const cut = path.join(DIR_CUT, `${ctx.chat.id}.png`);

  const wasEditingPhoto = s.editing === 'photo';
  const hadChars = s.chars.length > 0;

  // запускаем вырезку фона В ФОНЕ — НЕ ждём
  s.cutout = ''; s.cutStatus = 'pending';
  s.cutPromise = (async () => {
    let r;
    try { r = await runCutout(src, cut); } catch { r = { status: 'fail', message: 'ошибка обработки' }; }
    if (r.status === 'fail') {
      s.cutStatus = 'fail';
      await ctx.reply('❌ Фон убрать не удалось: ' + (r.message || '') + '\nПришли другое фото товара.').catch(() => {});
      return;
    }
    s.cutout = cut; s.cutStatus = r.status;
    const note = r.status === 'warn' ? '\n⚠️ ' + r.message : '';
    await ctx.replyWithPhoto(new InputFile(cut), {
      caption: '🪄 Фон убран — вот товар.' + note,
      reply_markup: new InlineKeyboard().text('🔁 Переснять фото', 'photo_retry'),
    }).catch(() => {});
    if (wasEditingPhoto) { s.editing = null; await buildCard(ctx, s).catch(() => {}); }  // правка фото → авто-пересборка
  })();

  if (wasEditingPhoto) return ctx.reply('📸 Фото принял! Убираю фон в фоне — пересоберу карточку, когда будет готово.');
  if (hadChars) return ctx.reply('📸 Новое фото принял! Убираю фон в фоне.', { reply_markup: new InlineKeyboard().text('✅ Собрать карточку', 'build') });
  s.idx = 0; s.chars = [];
  await ctx.reply('📸 Фото получил! Убираю фон в фоне 🪄 — а ты пока заполняй характеристики 👇');
  return askChar(ctx, s);
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

  if (d === 'new') return startNew(ctx, false);
  if (d === 'photo_retry') { s.step = STEP.PHOTO; return askPhoto(ctx, s); }
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
// страховка: не падать от неожиданных ошибок (рендер уже изолирован в подпроцессе)
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.message || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.message || e));
bot.start({ onStart: (i) => console.log(`✅ Бот @${i.username} запущен. Ctrl+C — стоп.`) });
