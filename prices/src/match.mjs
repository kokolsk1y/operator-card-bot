// Сравнение найденного товара с эталоном.
//
// Принцип: доверяем не релевантности маркетплейса (она мусорная), а только
// характеристикам, которые сами вытащили из названия. Расхождение по жёсткой
// характеристике = сразу отказ, без всяких баллов. Совпадение по всем
// известным = уверенность, пропорциональная весу подтверждённого.
//
// Отдельно различаем «не совпало» и «не указано». Продавец может не написать
// в названии цветовую температуру — это не повод отбрасывать товар, это повод
// не засчитывать его как подтверждённый.

import { canonArticle } from './normalize.mjs';
import { extractSpecs, extractPack, HARD_SPECS, SPEC_WEIGHT } from './specs.mjs';

/** Порог уверенности, выше которого товар считаем совпавшим. */
const MATCH_THRESHOLD = 0.7;

/** Сравнение конкретных характеристик, где точное равенство слишком строго. */
const COMPARE = {
  // 990 Лм и 1000 Лм — одна и та же лампа, продавцы округляют.
  lumens: (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.1,
  // 220 В, 230 В и 220-240 В — тоже одно и то же.
  voltage: (a, b) => (inMains(a) && inMains(b)) || a === b,
};
const inMains = (v) => v >= 210 && v <= 250;

const eq = (key, a, b) => (COMPARE[key] || ((x, y) => x === y))(a, b);

/**
 * Сопоставляет кандидата с эталоном.
 *
 * @param {{name:string, article?:string, brand?:string}} ref  наш товар
 * @param {{name:string, brand?:string}} cand                   найденный товар
 * @returns {{verdict:'match'|'reject'|'unsure', confidence:number,
 *            matched:string[], contradicted:string[], unknown:string[], reason:string}}
 */
export function matchProduct(ref, cand) {
  const refSpecs = extractSpecs(ref.name);
  const candSpecs = extractSpecs(cand.name);
  const pack = extractPack(cand.name);

  const matched = [];
  const contradicted = [];
  const unknown = [];

  // Собирает ответ, не давая забыть pack ни в одной из веток.
  const done = (verdict, confidence, reason) => ({
    verdict, confidence, pack, matched, contradicted, unknown, reason,
  });

  for (const key of Object.keys(refSpecs)) {
    const a = refSpecs[key];
    const b = candSpecs[key];
    if (b === undefined) unknown.push(key);
    else if (eq(key, a, b)) matched.push(key);
    else contradicted.push(`${key}: ждали ${a}, у него ${b}`);
  }

  // Расхождение по жёсткой характеристике — это другой товар, и точка.
  const hardMiss = contradicted.filter((c) => HARD_SPECS.includes(c.split(':')[0]));
  if (hardMiss.length) return done('reject', 0, `не тот товар — ${hardMiss.join('; ')}`);

  // Бренд: если оба известны и разные — тоже другой товар.
  if (ref.brand && cand.brand && canonArticle(ref.brand) !== canonArticle(cand.brand)) {
    return done('reject', 0, `другой бренд — ждали ${ref.brand}, у него ${cand.brand}`);
  }

  // Артикул производителя в названии — сильнейший сигнал, перекрывает пороги.
  if (ref.article) {
    const a = canonArticle(ref.article);
    if (a.length >= 6 && canonArticle(cand.name).includes(a)) {
      return done('match', 1, `артикул ${ref.article} найден в названии`);
    }
  }

  const totalW = sumWeight(Object.keys(refSpecs));
  const confidence = totalW ? sumWeight(matched) / totalW : 0;

  return confidence >= MATCH_THRESHOLD
    ? done('match', confidence, `совпали: ${matched.join(', ')}`)
    : done('unsure', confidence,
        `мало подтверждений (${pct(confidence)}), не указано: ${unknown.join(', ') || '—'}`);
}

const sumWeight = (keys) => keys.reduce((n, k) => n + (SPEC_WEIGHT[k] || 1), 0);
const pct = (x) => `${Math.round(x * 100)}%`;
