// Локальный тест рендера без Telegram (данные = как в примере Сергея).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCard, closeBrowser } from './render.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(__dirname, '.tmp', 'test_card.png');

await renderCard({
  bgPath: path.join(__dirname, 'фон.png'),
  productPath: process.argv[2],
  title: { big: 'Удлинитель', sub: 'с выключателем' },
  badge: 'с заземлением',
  mainChar: { big: '1,5', small: 'метра' },
  chars: [
    { big: 'ПВС', small: '3х1 мм' },
    { big: '10А', small: 'нагрузка', note: '*до 2300Вт' },
    { big: '3 розетки' },
  ],
  outPath: out,
});
console.log('OK ->', out);
await closeBrowser();
