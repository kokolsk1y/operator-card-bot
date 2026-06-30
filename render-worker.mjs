// Изолированный процесс рендера. Бот вызывает его как подпроцесс (как cutout.py).
// Если puppeteer/sharp упадёт — умрёт только этот воркер, а бот выживет.
//   node render-worker.mjs <путь_к_job.json>
// job.json = { bgPath, productPath, title, badge, mainChar, chars, offsets, outPath }
import fs from 'node:fs';
import { renderCard } from './render.mjs';

const jobPath = process.argv[2];
if (!jobPath) { console.error('no job path'); process.exit(2); }

const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
try {
  await renderCard(job);
} catch (e) {
  console.error(e?.stack || e?.message || String(e));
}
// Успех = файл карточки записан. Chromium закроется сам вместе с процессом —
// его закрытие иногда падает нативно, но карточка к этому моменту уже готова.
process.exit(fs.existsSync(job.outPath) ? 0 : 1);
