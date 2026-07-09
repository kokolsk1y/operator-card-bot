// Сборка карточки: HTML-шаблон -> Puppeteer -> PNG.
// Зоны и размеры шрифтов — из пиксельного обмера примера Сергея (ТЗ.md, п.3).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// шрифты @fontsource резолвим через модуль — работает и из общего node_modules, и из своего (на сервере)
const FONTS_DIR = path.join(path.dirname(require.resolve('@fontsource/montserrat/package.json')), 'files');

// ── единое место правки макета (px при ширине 900×1200) ─────────────────────
const LAYOUT = {
  W: 900, H: 1200, scale: 2,
  colors: { white: '#F2EBEB', orange: '#E0643C' },
  title: {                                   // по центру, с боковыми отступами
    margin: 48, top: 60, bigSize: 120,
    subTop: 190, subSize: 48,
  },
  badge: { top: 252, padX: 26, padY: 12, size: 40, radius: 18, border: 3 },  // по центру
  square: { left: 42, top: 360, width: 176, height: 140, radius: 16,
            bigSize: 84, smallSize: 32 },
  chars: { left: 46, top: 552, width: 210, pitch: 152,
           bigSize: 66, bigAloneSize: 50, smallSize: 40, noteSize: 22,
           divW: 172, divH: 3, divGap: 12 },
  // сейф-зоны: товар считается динамически, чтобы НЕ залезать на шапку/колонку характеристик
  safe: {
    gapBelowHeader: 28,   // отступ верха товара от низа шапки (заголовок+подзаг+бейдж)
    leftColRight: 260,    // правый край колонки характеристик (оранж.квадрат/полоски)
    gapFromChars: 40,     // отступ товара от колонки характеристик
    centeredMaxW: 660,    // макс. ширина товара по центру (когда характеристик нет)
    sideMargin: 40, bottomMargin: 40,
  },
};

// уровни свечения вокруг товара (0 — нет … 3 — сильное). Авто-выбор по яркости товара.
const GLOW = {
  0: 'none',
  1: 'drop-shadow(0 0 8px rgba(255,255,255,.40))',
  2: 'drop-shadow(0 0 12px rgba(255,255,255,.62)) drop-shadow(0 0 22px rgba(255,255,255,.40))',
  3: 'drop-shadow(0 0 14px rgba(255,255,255,.85)) drop-shadow(0 0 30px rgba(255,255,255,.55))',
};

function b64(file) { return fs.readFileSync(file).toString('base64'); }
// Montserrat ExtraBold (800) — как в примере; латиница и кириллица отдельными сабсетами
const RANGE_LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const RANGE_CYR = 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116';
function fontFace(weight, file, range) {
  return `@font-face{font-family:'Montserrat';font-weight:${weight};font-style:normal;` +
         `src:url(data:font/woff2;base64,${b64(path.join(FONTS_DIR, file))}) format('woff2');unicode-range:${range};}`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
    });
  }
  return browserPromise;
}

function buildHtml({ bgB64, productB64, title, badge, mainChar, chars, offsets, glow, productScale }) {
  const L = LAYOUT;
  const o = (k) => (offsets && offsets[k]) || { x: 0, y: 0 };  // смещение элемента
  const g = o('group');                                        // смещение всей группы (оранж + хар-ки)
  const hasChars = !!(mainChar || (chars && chars.length));    // есть ли вообще характеристики
  const op = o('product');
  const gl = GLOW[glow] != null ? GLOW[glow] : GLOW[2];        // сила свечения
  const ps = productScale || 1;                                // масштаб товара

  // ── СЕЙФ-ЗОНА ТОВАРА: строго ниже шапки (заголовок+подзаг+бейдж) и правее колонки ──
  const S = L.safe;
  const bigBottom = L.title.top + L.title.bigSize;                                             // низ большого слова
  const subBottom = title.sub ? L.title.subTop + L.title.subSize : 0;                          // низ подзаголовка
  const badgeBottom = badge ? L.badge.top + L.badge.size + 2 * L.badge.padY + 2 * L.badge.border + 6 : 0; // низ бейджа
  const headerBottom = Math.max(bigBottom, subBottom, badgeBottom);                            // низ всей шапки
  const pTop = headerBottom + S.gapBelowHeader;
  const pBottom = L.H - S.bottomMargin;
  let pLeft, pRight;
  if (hasChars) { pLeft = S.leftColRight + S.gapFromChars; pRight = L.W - S.sideMargin; }       // справа от колонки
  else { const cw = Math.min(S.centeredMaxW, L.W - 2 * S.sideMargin); pLeft = (L.W - cw) / 2; pRight = pLeft + cw; } // по центру
  const pz = { left: pLeft, top: pTop, width: pRight - pLeft, height: pBottom - pTop };

  const fontsCss =
    fontFace(800, 'montserrat-latin-800-normal.woff2', RANGE_LATIN) +
    fontFace(800, 'montserrat-cyrillic-800-normal.woff2', RANGE_CYR);

  // заголовок: большое слово + подзаголовок — во всю ширину, по центру
  const ot = o('title');
  const tMar = L.title.margin, tW = L.W - 2 * tMar;
  const titleHtml = `
    <div class="abs" style="left:${tMar + ot.x}px;top:${L.title.top + ot.y}px;width:${tW}px">
      <div class="fit big upper center" style="font-size:${L.title.bigSize}px">${esc(title.big)}</div>
    </div>
    ${title.sub ? `<div class="abs" style="left:${tMar + ot.x}px;top:${L.title.subTop + ot.y}px;width:${tW}px">
      <div class="fit big upper center" style="font-size:${L.title.subSize}px">${esc(title.sub)}</div></div>` : ''}`;

  // бейдж в рамке — по центру карточки
  const ob = o('badge');
  const badgeHtml = badge ? `
    <div class="abs" style="left:${ob.x}px;top:${L.badge.top + ob.y}px;width:${L.W}px;text-align:center">
      <span class="badge" style="padding:${L.badge.padY}px ${L.badge.padX}px;border:${L.badge.border}px solid ${L.colors.white};border-radius:${L.badge.radius}px">
        <span class="badge-t" style="font-size:${L.badge.size}px">${esc(badge)}</span></span>
    </div>` : '';

  // оранжевый квадрат: значение + подпись (двигается вместе с группой)
  const sq = mainChar; const os = o('square');
  const squareHtml = sq ? `
    <div class="abs square" style="left:${L.square.left + os.x + g.x}px;top:${L.square.top + os.y + g.y}px;
         width:${L.square.width}px;height:${L.square.height}px;
         background:${L.colors.orange};border-radius:${L.square.radius}px">
      <div class="fit big" style="font-size:${L.square.bigSize}px">${esc(sq.big)}</div>
      ${sq.small ? `<div class="fit big" style="font-size:${L.square.smallSize}px">${esc(sq.small)}</div>` : ''}
    </div>` : '';

  // характеристики: значение + подпись + примечание + линия-разделитель
  const charsHtml = (chars || []).map((c, i) => {
    const alone = !c.small && !c.note; const oc = o('char' + i);
    return `
    <div class="abs cblock" style="left:${L.chars.left + g.x + oc.x}px;top:${L.chars.top + i * L.chars.pitch + g.y + oc.y}px;width:${L.chars.width}px">
      <div class="fit big" style="font-size:${alone ? L.chars.bigAloneSize : L.chars.bigSize}px">${esc(c.big)}</div>
      ${c.small ? `<div class="fit big" style="font-size:${L.chars.smallSize}px">${esc(c.small)}</div>` : ''}
      ${c.note ? `<div class="fit note" style="font-size:${L.chars.noteSize}px">${esc(c.note)}</div>` : ''}
      <div class="divider" style="width:${L.chars.divW}px;height:${L.chars.divH}px;margin-top:${L.chars.divGap}px"></div>
    </div>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${fontsCss}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${L.W}px;height:${L.H}px}
    .card{position:relative;width:${L.W}px;height:${L.H}px;overflow:hidden;
          font-family:'Montserrat',sans-serif;color:${L.colors.white}}
    .bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
    .abs{position:absolute}
    .fit{display:block;width:100%;white-space:nowrap;font-weight:800;line-height:1.04}
    .upper{text-transform:uppercase}
    .center{text-align:center}
    .big{letter-spacing:-0.5px}
    .square{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:6px 12px}
    .badge{display:inline-flex;align-items:center}
    .badge-t{font-weight:700;white-space:nowrap}
    .cblock .fit{margin-bottom:2px}
    .note{text-transform:none;opacity:.95}
    .divider{background:${L.colors.white};opacity:.9;border-radius:2px}
    .product{position:absolute;display:flex;align-items:center;justify-content:center}
    .product img{max-width:100%;max-height:100%;object-fit:contain}
  </style></head><body>
    <div class="card">
      <img class="bg" src="data:image/png;base64,${bgB64}">
      ${titleHtml}
      ${badgeHtml}
      ${squareHtml}
      ${charsHtml}
      <div class="product" style="left:${pz.left + op.x}px;top:${pz.top + op.y}px;width:${pz.width}px;height:${pz.height}px"><img src="data:image/png;base64,${productB64}" style="filter:${gl};transform:scale(${ps})"></div>
    </div>
  </body></html>`;
}

// ужимаем шрифт каждого .fit, пока текст не влезет в свою ширину
const FIT_SCRIPT = () => {
  document.querySelectorAll('.fit').forEach((el) => {
    if (el.clientWidth < 5) return;                       // зона ещё не отрисована — не трогаем
    let fs = parseFloat(getComputedStyle(el).fontSize);
    let guard = 300;
    // .fit заполняет ширину своей зоны (width:100%), поэтому scrollWidth>clientWidth = текст не влез
    while (guard-- > 0 && fs > 8 && el.scrollWidth > el.clientWidth + 1) {
      fs -= 1; el.style.fontSize = fs + 'px';
    }
  });
};

/**
 * @param {object} o
 * @param {string} o.bgPath
 * @param {string} o.productPath
 * @param {{big:string, sub?:string}} o.title
 * @param {string|null} o.badge
 * @param {{big:string, small?:string}|null} o.mainChar
 * @param {Array<{big:string, small?:string, note?:string}>} o.chars
 * @param {Object<string,{x:number,y:number}>} [o.offsets] смещения элементов (title/badge/square/group/product/char0..)
 * @param {string} o.outPath
 */
export async function renderCard({ bgPath, productPath, title, badge, mainChar, chars, offsets, glow, productScale, outPath }) {
  const html = buildHtml({
    bgB64: b64(bgPath), productB64: b64(productPath),
    title, badge: badge || null, mainChar: mainChar || null, chars: chars || [], offsets: offsets || {},
    glow: glow == null ? 2 : glow, productScale: productScale || 1,
  });
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: LAYOUT.W, height: LAYOUT.H, deviceScaleFactor: LAYOUT.scale });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(async () => { if (document.fonts) await document.fonts.ready; });
    await page.evaluate(FIT_SCRIPT);
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: LAYOUT.W, height: LAYOUT.H } });
    await sharp(png).resize(LAYOUT.W, LAYOUT.H, { fit: 'fill' }).png().toFile(outPath);
    return outPath;
  } finally {
    try { await page.close(); } catch {}   // закрытие не должно влиять на результат
  }
}

export async function closeBrowser() {
  if (browserPromise) { const b = await browserPromise; await b.close(); browserPromise = null; }
}
