// Ручная проверка связки «поиск → отсев → цены по ID» на живом WB.
// Сеть нужна, поэтому в автотесты не годится (там фикстура).
//
// Запуск: node prices/smoke.mjs

import { searchProducts, fetchPrices, rub } from './src/wb.mjs';
import { matchProduct } from './src/match.mjs';

const REF = {
  name: 'Лампа LED A60 E27 3000K 11Вт 990Lm IEK',
  article: 'LLE-A60-11-230-30-E27',
  brand: 'IEK',
  ourPriceKop: 3000, // наша закупочная, 30 ₽
};

console.log('Эталон:', REF.name);
console.log('Ищу на WB…\n');

const found = await searchProducts(REF.name);
console.log(`выдача WB: ${found.length} товаров\n`);

const scored = found.map((p, i) => ({ pos: i + 1, p, r: matchProduct(REF, p) }));
const byVerdict = { match: [], unsure: [], reject: [] };
for (const s of scored) byVerdict[s.r.verdict].push(s);

console.log('--- ОТСЕВ ---');
console.log('совпало:', byVerdict.match.length,
            '| под вопросом:', byVerdict.unsure.length,
            '| отсеяно:', byVerdict.reject.length);

console.log('\n--- ЧТО ПРОШЛО ---');
for (const { pos, p, r } of byVerdict.match) {
  const unit = p.priceKop == null ? null : Math.round(p.priceKop / r.pack);
  console.log(`#${pos} ${p.name}`);
  console.log(`   ${p.brand} · ${p.supplier}`);
  console.log(`   лот: ${rub(p.priceKop)} × ${r.pack} шт → за штуку ${rub(unit)}`);
  console.log(`   наша закупочная ${rub(REF.ourPriceKop)} → ${
    unit != null && unit < REF.ourPriceKop ? '🔥 ДЕШЕВЛЕ' : 'дороже, мимо'}`);
  console.log(`   ${p.url}`);
}

console.log('\n--- ПРИМЕРЫ ОТСЕВА (первые 3) ---');
for (const { pos, p, r } of byVerdict.reject.slice(0, 3)) {
  console.log(`#${pos} ${p.name.slice(0, 50)}\n   → ${r.reason}`);
}

const ids = byVerdict.match.map((m) => m.p.id);
if (ids.length) {
  console.log('\n--- ПРОВЕРКА ЦЕН ПО ID (режим мониторинга) ---');
  const prices = await fetchPrices(ids);
  for (const [id, p] of prices) console.log(`${id}: ${rub(p.priceKop)} | остаток: ${p.stock}`);
}
