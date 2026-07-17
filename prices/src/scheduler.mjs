// Периодические задачи.
//
// Два ритма, и это осознанно разные вещи:
//   поиск кандидатов — раз в сутки: дорого, мусорно, ловит 429;
//   проверка цен     — раз в 20 минут: дёшево, точно, по подтверждённым ID.
//
// Регистрируется ДО bot.start(): тот не возвращает управление, пока бот жив.

import { InlineKeyboard } from 'grammy';
import { config } from './config.mjs';
import { listOurProducts, pendingCandidates } from './db.mjs';
import { findCandidatesFor } from './finder.mjs';
import { checkPrices } from './monitor.mjs';
import { rub } from './wb.mjs';

/** Не даёт задаче наложиться на саму себя, если прошлый прогон затянулся. */
function once(name, fn) {
  let running = false;
  return async () => {
    if (running) return console.warn(`${name}: прошлый прогон ещё идёт, пропускаю`);
    running = true;
    try { await fn(); }
    catch (e) { console.error(`${name} упал:`, e); }
    finally { running = false; }
  };
}

const dealKeyboard = (url) => new InlineKeyboard().url('Открыть на маркетплейсе', url);

const candKeyboard = (id) =>
  new InlineKeyboard()
    .text('✅ Это оно', `pm:cand:ok:${id}`)
    .text('❌ Не то', `pm:cand:no:${id}`);

/** Сообщение о находке. Показываем расчёт, а не только вывод. */
function dealText({ ourProduct, watched, offer, verdict }) {
  return [
    '🔥 Дешевле нашей закупочной',
    '',
    ourProduct.name,
    '',
    `${offer.name}`,
    `${offer.supplier ?? '—'}`,
    '',
    `Цена: ${rub(offer.priceKop)}${watched.pack > 1 ? ` за ${watched.pack} шт` : ''}`,
    `За штуку: ${rub(verdict.unitKop)}`,
    `Наша закупочная: ${rub(verdict.ourNetKop)}`,
    `Выгода: ${rub(verdict.savingKop)}/шт`,
    offer.stock != null ? `Остаток: ${offer.stock} шт` : '',
    '',
    `Расчёт: ${verdict.why}`,
    offer.vatReturnable ? '' : '⚠️ Возврат НДС не подтверждён — считал по полной цене',
  ].filter(Boolean).join('\n');
}

function candText(c, ourProduct) {
  const unit = c.price_kop == null ? null : Math.round(c.price_kop / Math.max(1, c.pack));
  return [
    'Нашёл похожее — это наш товар?',
    '',
    `Ищем: ${ourProduct.name}`,
    '',
    `Найдено: ${c.name}`,
    `${c.brand ?? ''} · ${c.supplier ?? '—'}`,
    `Цена: ${rub(c.price_kop)}${c.pack > 1 ? ` за ${c.pack} шт → ${rub(unit)}/шт` : ''}`,
    '',
    `Совпадение: ${Math.round((c.confidence ?? 0) * 100)}% — ${c.reason ?? ''}`,
    c.url ?? '',
  ].filter(Boolean).join('\n');
}

export function startScheduler(db, bot) {
  const notifyDeal = async (deal) => {
    await bot.api.sendMessage(deal.ourProduct.owner_id, dealText(deal), {
      reply_markup: deal.offer.url ? dealKeyboard(deal.offer.url) : undefined,
      link_preview_options: { is_disabled: true },
    }).catch((e) => console.error('не смог отправить находку:', e.message));
  };

  const runCheck = once('проверка цен', async () => {
    const r = await checkPrices(db, notifyDeal);
    if (r.checked) console.log(`проверка цен: ${r.checked} шт, изменилось ${r.changed}, находок ${r.deals}`);
  });

  const runSearch = once('поиск кандидатов', async () => {
    const owners = new Set(
      db.prepare('SELECT DISTINCT owner_id FROM our_products WHERE active = 1').all()
        .map((r) => r.owner_id));

    for (const owner of owners) {
      for (const product of listOurProducts(db, owner)) {
        const stat = await findCandidatesFor(db, product);
        if (!stat.shown) continue;
        console.log(`«${product.name}»: показываю ${stat.shown}, отсеяно ${stat.rejected}`);

        for (const c of pendingCandidates(db, product.id)) {
          await bot.api.sendMessage(owner, candText(c, product), {
            reply_markup: candKeyboard(c.id),
            link_preview_options: { is_disabled: true },
          }).catch((e) => console.error('не смог отправить кандидата:', e.message));
        }
      }
    }
  });

  setInterval(runCheck, config.checkEveryMin * 60_000);
  setInterval(runSearch, config.searchEveryHours * 3_600_000);

  // Первый прогон цен — вскоре после старта, но не мгновенно: даём боту встать.
  setTimeout(runCheck, 30_000);

  console.log(
    `планировщик: цены каждые ${config.checkEveryMin} мин, ` +
    `поиск раз в ${config.searchEveryHours} ч`);

  return { runCheck, runSearch };
}
