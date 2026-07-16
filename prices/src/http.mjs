// HTTP-транспорт для маркетплейсов. Здесь два неочевидных решения, оба выстраданы
// экспериментом 2026-07-16 — не «упрощайте» их обратно, отвалится молча.
//
// 1. node:https, а НЕ fetch().
//    undici (движок fetch в Node) принудительно добавляет «Sec-Fetch-Mode: cors»
//    и «Accept-Language: *» и не даёт их переопределить. WB видит признаки
//    кросс-доменного запроса из браузера без Origin и отвечает 403.
//    node:https шлёт ровно то, что попросили.
//
// 2. ciphers: 'DEFAULT'.
//    У Node свой список TLS-шифров по умолчанию, и он опознаётся по отпечатку.
//    card.wb.ru (server: wbaas) на него отвечает 403, тогда как curl и python
//    с тем же URL получают 200. 'DEFAULT' — это набор OpenSSL, тот же, что у
//    curl. Проверено: без него 403, с ним 200.
//
// Забавно, что «притвориться Chrome» тут ВРЕДИТ: curl_cffi с impersonate=chrome
// получает 403, а голый curl — 200.

import https from 'node:https';

/** Переиспользуем соединения и держим «правильный» отпечаток TLS. */
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 4,
  ciphers: 'DEFAULT',
});

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Один GET, без ретраев. Возвращает {status, body}. */
function rawGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { agent, headers: { 'User-Agent': UA, Accept: '*/*' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`таймаут ${timeoutMs}мс`)));
  });
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * GET с повтором на 429/5xx и растущей паузой.
 * Лимиты у WB жёсткие: 429 прилетает уже на 4-м запросе подряд, так что
 * пауза между вызовами — не вежливость, а условие работоспособности.
 */
export async function getJson(url, { attempts = 4, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await rawGet(url, timeoutMs);
      if (RETRY_STATUS.has(res.status)) {
        lastErr = new Error(`ответ ${res.status}`);
        await sleep(2000 * 2 ** i);
        continue;
      }
      if (res.status !== 200) throw new Error(`ответ ${res.status}`);
      return JSON.parse(res.body);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(2000 * 2 ** i);
    }
  }
  throw lastErr ?? new Error('недоступно');
}

/** Очередь с минимальным интервалом — общая на все площадки. */
export function makeThrottle(minGapMs) {
  let last = 0;
  let chain = Promise.resolve();
  return (fn) => {
    chain = chain.then(async () => {
      const wait = last + minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
    });
    return chain.then(fn);
  };
}
