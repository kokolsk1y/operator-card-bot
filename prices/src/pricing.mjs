// Решение «выгодно или нет».
//
// Тут легко потерять деньги на ровном месте, поэтому логика записана явно.
//
// Что нам сообщает витрина B2B (бейдж «Возврат НДС 22%» на карточке Ozon
// для бизнеса): ставку и то, что НДС ВОЗВРАЩАЕТСЯ. Если бейджа нет — НДС
// не вернуть, даже если он сидит в цене.
//
// Ключевая ловушка: делить цену на 1.22 «потому что НДС 22%» — прямой убыток.
// Продавец на УСН НДС не платит, в его цене НДС нет вообще. Поделив, бот
// придумает несуществующую скидку 18% и купит дороже, чем закупает сам.
// Поэтому делим ТОЛЬКО когда витрина явно сказала «возврат НДС».

/**
 * Приводит цену к «реальным затратам» — сколько денег останется потрачено
 * после того, как возместимый НДС вернётся.
 *
 * @param {number} kop        цена в копейках
 * @param {boolean} vatReturnable  НДС из этой цены можно принять к вычету
 * @param {number|null} vatRate    ставка, % (0/5/7/10/22) — с витрины, не константа
 */
export function netCost(kop, vatReturnable, vatRate) {
  if (kop == null) return null;
  if (!vatReturnable || !vatRate) return kop; // НДС не вернуть — платим всё
  return Math.round(kop / (1 + vatRate / 100));
}

/**
 * Оценивает предложение против нашего товара.
 *
 * @param {{priceKop:number, pack:number, vatReturnable:boolean, vatRate:number|null}} offer
 *        priceKop — цена ЛОТА (не штуки!), pack — штук в лоте
 * @param {{priceKop:number, priceHasVat:boolean, vatRate:number|null}} our
 *        priceKop — наша закупочная за ШТУКУ
 * @returns {{unitKop, offerNetKop, ourNetKop, savingKop, worthIt, why}}
 */
export function evaluateOffer(offer, our) {
  const pack = Math.max(1, offer.pack || 1);
  const unitKop = offer.priceKop == null ? null : Math.round(offer.priceKop / pack);

  if (unitKop == null) {
    return { unitKop: null, offerNetKop: null, ourNetKop: null, savingKop: null,
             worthIt: false, why: 'цена неизвестна' };
  }

  const offerNetKop = netCost(unitKop, offer.vatReturnable, offer.vatRate);

  // Нашу закупочную приводим к той же базе. Если она указана С НДС и наш НДС
  // возместим — сравниваем без него; иначе как есть.
  const ourNetKop = netCost(our.priceKop, our.priceHasVat, our.vatRate);

  const savingKop = ourNetKop - offerNetKop;
  const worthIt = savingKop > 0;

  return {
    unitKop, offerNetKop, ourNetKop, savingKop, worthIt,
    why: explain({ pack, unitKop, offer, offerNetKop, ourNetKop, savingKop, worthIt }),
  };
}

function explain({ pack, unitKop, offer, offerNetKop, ourNetKop, savingKop, worthIt }) {
  const bits = [];
  if (pack > 1) bits.push(`лот ${r(offer.priceKop)} ÷ ${pack} шт = ${r(unitKop)}/шт`);
  bits.push(
    offer.vatReturnable && offer.vatRate
      ? `возврат НДС ${offer.vatRate}% → чистая ${r(offerNetKop)}`
      : 'НДС не возвращается → платим полную',
  );
  bits.push(
    worthIt
      ? `дешевле нашей (${r(ourNetKop)}) на ${r(savingKop)}/шт`
      : `дороже нашей (${r(ourNetKop)}) на ${r(-savingKop)}/шт`,
  );
  return bits.join('; ');
}

const r = (kop) => (kop == null ? '—' : `${(kop / 100).toFixed(2)} ₽`);
