// Диагностика доступности Ozon. Запускать С РОССИЙСКОГО IP (VPN выключен),
// а лучше сразу на сервере бота.
//
//   node prices/probe-ozon.mjs
//
// Отвечает на три вопроса, которые сейчас блокируют адаптер Озона:
//   1. Какой у нас внешний IP и не датацентр ли это (за это Ozon и банит).
//   2. Пускает ли антибот автоматический клиент.
//   3. Виден ли бейдж «Возврат НДС» на витрине для юрлиц БЕЗ логина.
//
// При успехе сохраняет живой ответ в .probe/ — по нему пишется разбор.

import https from 'node:https';
import { writeFileSync, mkdirSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const agent = new https.Agent({ keepAlive: true, ciphers: 'DEFAULT' });

function get(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent, headers: { 'User-Agent': UA, Accept: '*/*' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          location: res.headers.location,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('таймаут')));
  });
}

const line = (s = '') => console.log(s);
const head = (s) => { line(); line(`=== ${s} ===`); };

/* ---------- 1. кто мы снаружи ---------- */

head('1. НАШ ВНЕШНИЙ IP');
let ipInfo = {};
try {
  const r = await get('https://ipinfo.io/json');
  ipInfo = JSON.parse(r.body);
  line(`IP:  ${ipInfo.ip}`);
  line(`Сеть: ${ipInfo.org}`);
  line(`Гео: ${ipInfo.city}, ${ipInfo.country}`);
  if (ipInfo.country !== 'RU') {
    line('\n⚠️  IP НЕ российский. Ozon такие режет — дальше почти наверняка 403.');
    line('   Выключи VPN или запусти это на сервере (78.36.202.208).');
  } else {
    line('\n✓ Российский IP — то, что Ozon и хочет видеть.');
  }
} catch (e) {
  line(`не смог определить IP: ${e.message}`);
}

/* ---------- 2. пускает ли антибот ---------- */

const targets = [
  ['РОЗНИЧНАЯ витрина (для физлиц)', 'https://www.ozon.ru/search/?text=lampa+led+e27'],
  ['ВИТРИНА ДЛЯ ЮРЛИЦ (нужна нам)', 'https://www.ozon.ru/business/search/?text=lampa+led+e27'],
  ['composer-api розница', 'https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=%2Fsearch%2F%3Ftext%3Dlampa'],
  ['composer-api юрлица', 'https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=%2Fbusiness%2Fsearch%2F%3Ftext%3Dlampa'],
];

const results = [];
for (const [label, url] of targets) {
  head(`2. ${label}`);
  try {
    const r = await get(url);
    const antibot = r.headers['ozon-antibot'];
    line(`HTTP ${r.status}${r.location ? ` → ${String(r.location).slice(0, 70)}` : ''}`);
    if (antibot) line(`ozon-antibot: ${antibot}   ← нас опознали как бота/плохой IP`);
    line(`тело: ${r.body.length} байт`);

    const text = r.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (r.status !== 200) line(`сообщение: ${text.slice(0, 160)}`);

    results.push({ label, status: r.status, antibot: !!antibot, size: r.body.length });

    if (r.status === 200 && r.body.length > 3000) {
      mkdirSync('.probe', { recursive: true });
      const file = `.probe/${label.replace(/[^a-zа-я0-9]+/gi, '_')}.txt`;
      writeFileSync(file, r.body);
      line(`✓ ПРОШЛО. Ответ сохранён: ${file}`);

      // Бейдж «Возврат НДС» — ради него всё и затевалось.
      const vat = r.body.match(/Возврат\s*НДС\s*(\d{1,2})\s*%/i);
      if (vat) line(`🎯 НАЙДЕН БЕЙДЖ «Возврат НДС ${vat[1]}%» — и БЕЗ логина!`);
      else if (/business/i.test(url)) line('⚠️  бейджа «Возврат НДС» в ответе нет — возможно, нужен вход');

      // Прогоняем боевой разборщик по живому ответу composer-api.
      if (/composer/.test(url)) {
        try {
          const { extractOffers } = await import('./src/ozon-parse.mjs');
          const offers = extractOffers(JSON.parse(r.body));
          line(`🧩 разборщик извлёк товаров: ${offers.length}`);
          for (const o of offers.slice(0, 3)) {
            line(`   • ${(o.name || '—').slice(0, 40)} | ${o.priceKop ? o.priceKop / 100 + '₽' : '—'}` +
                 `${o.vatReturnable ? ` | НДС ${o.vatRate}%` : ''}`);
          }
          if (!offers.length) line('   (0 — структура иная, чем в синтетик-тесте; поправлю по этому файлу)');
        } catch (e) { line(`   разбор не удался: ${e.message}`); }
      }
    }
  } catch (e) {
    line(`ошибка: ${e.message}`);
    results.push({ label, status: 'ERR', antibot: false, size: 0 });
  }
  await new Promise((r) => setTimeout(r, 3000)); // не долбим
}

/* ---------- 3. вердикт ---------- */

head('ВЕРДИКТ');
const ok = results.filter((r) => r.status === 200);
if (!ok.length) {
  line('❌ Ozon не пустил никуда.');
  line(ipInfo.country && ipInfo.country !== 'RU'
    ? '   Причина очевидна: нероссийский IP. Перезапусти без VPN / на сервере.'
    : '   IP российский, но антибот всё равно режет — значит дело не в IP,\n' +
      '   и понадобится браузер или официальный поставщик данных.');
} else {
  line(`✓ Прошло: ${ok.map((r) => r.label).join(', ')}`);
  line('  Ответы в .probe/ — по ним пишу разбор и включаю адаптер.');
}
line();
line('Скинь этот вывод целиком — по нему видно, что делать дальше.');
