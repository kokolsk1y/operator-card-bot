// Изолированный процесс рендера. Бот вызывает его как подпроцесс (как cutout.py).
// Если puppeteer/sharp упадёт нативно — умрёт только этот воркер, а бот выживет.
//   node render-worker.mjs <путь_к_job.json>
// job.json = { bgPath, productPath, title, badge, mainChar, chars, offsets, outPath }
import fs from 'node:fs';
import { renderCard, closeBrowser } from './render.mjs';

const jobPath = process.argv[2];
if (!jobPath) { console.error('no job path'); process.exit(2); }

try {
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  await renderCard(job);
  await closeBrowser();
  process.exit(0);
} catch (e) {
  console.error(e?.stack || e?.message || String(e));
  try { await closeBrowser(); } catch {}
  process.exit(1);
}
