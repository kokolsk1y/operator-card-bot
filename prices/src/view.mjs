// Оформление сообщений. Telegram понимает узкий HTML: <b> <i> <code> <pre> <a>.
// Всё пользовательское экранируем — иначе «<» в названии сломает разметку.
//
// Держим оформление отдельно от логики: finder считает, view показывает.

const rub0 = (kop) => (kop == null ? '—' : `${Math.round(kop / 100)} ₽`);

/** Экранирование под HTML-режим Telegram. */
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const MP = { wb: 'WB', ozon: 'OZ' };

/** Одна строка результата: флаг · цена/шт · площадка · название · продавец. */
function resultLine({ offer, match, deal }) {
  const flag = deal.worthIt ? '🔥' : '▫️';
  const mp = MP[offer.marketplace] || offer.marketplace;
  const seller = offer.supplier ? ` · ${esc(offer.supplier.slice(0, 22))}` : '';
  const title = esc(offer.name.slice(0, 46));

  // Крупно — цена ЛОТА (ровно то, что покажет страница по ссылке), чтобы при
  // клике цифра совпадала. Для связок рядом даём расчёт за штуку, по которому
  // бот и сравнивает с нашей закупочной.
  const lot = rub0(offer.priceKop);
  const priceStr = match.pack > 1
    ? `<b>${lot}</b> за ${match.pack} шт = ${rub0(deal.unitKop)}/шт`
    : `<b>${lot}</b>`;

  return `${flag} <a href="${esc(offer.url)}">${priceStr}</a> · ${mp}\n` +
         `   ${title}${seller}`;
}

/**
 * Итог поиска по товару.
 * @param {{name, price_kop}} product
 * @param {{results, stats}} search
 * @param {number} limit сколько позиций показать
 */
export function renderSearch(product, { results, stats }, limit = 12) {
  const head =
    `🔎 <b>${esc(product.name)}</b>\n` +
    `наша закупочная: <b>${rub0(product.price_kop)}/шт</b>\n`;

  if (!results.length) {
    return head + '\nНичего похожего не нашлось. ' +
      'Попробуй уточнить название — добавь бренд и характеристики.';
  }

  const deals = results.filter((r) => r.deal.worthIt);
  const rest = results.filter((r) => !r.deal.worthIt);

  let body = '';
  if (deals.length) {
    body += `\n🔥 <b>Дешевле нашей (${deals.length}):</b>\n` +
      deals.slice(0, limit).map(resultLine).join('\n') + '\n';
  } else {
    body += `\n<i>Дешевле ${rub0(product.price_kop)}/шт не нашлось.</i>\n`;
  }

  // Немного «не дешевле» — чтобы видеть, что товар вообще на рынке и почём.
  const restShow = rest.slice(0, deals.length ? 3 : 6);
  if (restShow.length) {
    body += `\n▫️ <b>Есть на рынке (для ориентира):</b>\n` +
      restShow.map(resultLine).join('\n') + '\n';
  }

  const foot =
    `\n<i>Проверено ${stats.found} предложений по ${stats.queries} запросам. ` +
    `Точных совпадений: ${stats.matches}.</i>`;

  return head + body + foot;
}

/** Карточка товара в списке /list. */
export function renderProductRow(p) {
  const price = rub0(p.price_kop);
  const vat = p.price_has_vat ? ' с НДС' : '';
  let status = '';
  if (p.last_checked_at) {
    const when = new Date(p.last_checked_at).toLocaleDateString('ru-RU',
      { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    status = p.last_deals
      ? `\n   🔥 в прошлый раз дешевле: <b>${p.last_deals}</b> · ${when}`
      : `\n   ▫️ дешевле не было · ${when}`;
  } else {
    status = '\n   <i>ещё не проверялся</i>';
  }
  const art = p.article ? ` · <code>${esc(p.article)}</code>` : '';
  return `<b>#${p.id}</b> ${esc(p.name)}\n   закупочная ${price}${vat}${art}${status}`;
}
