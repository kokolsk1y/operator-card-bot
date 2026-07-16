// Хранилище на встроенном node:sqlite — без нативных зависимостей и сборки.
// Требует Node 22+, поэтому сервис цен едет на своём образе (node:24-alpine),
// отдельно от бота карточек с его Node 20, rembg и chromium.
//
// ВАЖНО ПРО ДЕПЛОЙ: файл БД обязан лежать на volume. У бота карточек в
// docker-compose.yml volumes нет вообще, файловая система контейнера эфемерна —
// без тома история цен умрёт при первой же пересборке образа.
//
// Деньги везде в КОПЕЙКАХ (INTEGER). Даты — ISO-строки в UTC.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  // WAL — чтобы планировщик и бот не блокировали друг друга на записи.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    -- Наши товары: эталон для поиска и цена, с которой сравниваем.
    CREATE TABLE IF NOT EXISTS our_products (
      id            INTEGER PRIMARY KEY,
      name          TEXT    NOT NULL,
      article       TEXT,
      brand         TEXT,
      price_kop     INTEGER NOT NULL,          -- наша закупочная, за ШТУКУ
      price_has_vat INTEGER NOT NULL DEFAULT 1,-- закупочная указана с НДС?
      vat_rate      INTEGER,                   -- ставка НДС нашего товара, %
      owner_id      INTEGER NOT NULL,          -- telegram user_id завёдшего
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL
    );

    -- Кандидаты: найдено ботом, ждёт подтверждения человеком.
    CREATE TABLE IF NOT EXISTS candidates (
      id             INTEGER PRIMARY KEY,
      our_product_id INTEGER NOT NULL REFERENCES our_products(id) ON DELETE CASCADE,
      marketplace    TEXT    NOT NULL,
      external_id    TEXT    NOT NULL,
      name           TEXT, brand TEXT, supplier TEXT, url TEXT,
      pack           INTEGER NOT NULL DEFAULT 1,
      price_kop      INTEGER,
      confidence     REAL,
      reason         TEXT,
      status         TEXT    NOT NULL DEFAULT 'pending', -- pending|confirmed|rejected
      found_at       TEXT    NOT NULL,
      UNIQUE (our_product_id, marketplace, external_id)
    );

    -- Отслеживаемые предложения: подтверждено человеком, следим за ценой.
    CREATE TABLE IF NOT EXISTS watched (
      id             INTEGER PRIMARY KEY,
      our_product_id INTEGER NOT NULL REFERENCES our_products(id) ON DELETE CASCADE,
      marketplace    TEXT    NOT NULL,
      external_id    TEXT    NOT NULL,
      name           TEXT, brand TEXT, supplier TEXT, url TEXT,
      pack           INTEGER NOT NULL DEFAULT 1,  -- штук в лоте: цена лота / pack
      active         INTEGER NOT NULL DEFAULT 1,
      confirmed_by   INTEGER,
      confirmed_at   TEXT    NOT NULL,
      last_seen_at   TEXT,
      last_price_kop INTEGER,                     -- цена ЛОТА при прошлой проверке
      UNIQUE (our_product_id, marketplace, external_id)
    );

    -- История цен. Пишем ТОЛЬКО при изменении: 500 товаров × каждые 15 минут
    -- это ~48 тысяч строк в сутки на ровном месте, а меняется цена редко.
    CREATE TABLE IF NOT EXISTS price_history (
      id             INTEGER PRIMARY KEY,
      watched_id     INTEGER NOT NULL REFERENCES watched(id) ON DELETE CASCADE,
      price_kop      INTEGER,                     -- цена лота
      unit_price_kop INTEGER,                     -- цена за штуку (лот / pack)
      stock          INTEGER,
      seen_at        TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hist_watched ON price_history(watched_id, seen_at);
    CREATE INDEX IF NOT EXISTS idx_cand_status  ON candidates(status, our_product_id);
    CREATE INDEX IF NOT EXISTS idx_watch_active ON watched(active);
  `);

  return db;
}

const now = () => new Date().toISOString();

/* ---------- наши товары ---------- */

export function addOurProduct(db, { name, article, brand, priceKop, priceHasVat = true, vatRate, ownerId }) {
  const st = db.prepare(`
    INSERT INTO our_products (name, article, brand, price_kop, price_has_vat, vat_rate, owner_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const r = st.run(name, article ?? null, brand ?? null, priceKop,
                   priceHasVat ? 1 : 0, vatRate ?? null, ownerId, now());
  return Number(r.lastInsertRowid);
}

export const listOurProducts = (db, ownerId) =>
  db.prepare('SELECT * FROM our_products WHERE owner_id = ? AND active = 1 ORDER BY id').all(ownerId);

export const getOurProduct = (db, id) =>
  db.prepare('SELECT * FROM our_products WHERE id = ?').get(id);

/* ---------- кандидаты ---------- */

/** Кладёт кандидата. Повторная находка того же товара не плодит дублей. */
export function upsertCandidate(db, c) {
  db.prepare(`
    INSERT INTO candidates (our_product_id, marketplace, external_id, name, brand,
                            supplier, url, pack, price_kop, confidence, reason, found_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (our_product_id, marketplace, external_id) DO UPDATE SET
      price_kop = excluded.price_kop,
      confidence = excluded.confidence,
      reason = excluded.reason
  `).run(c.ourProductId, c.marketplace, c.externalId, c.name ?? null, c.brand ?? null,
         c.supplier ?? null, c.url ?? null, c.pack ?? 1, c.priceKop ?? null,
         c.confidence ?? null, c.reason ?? null, now());
}

export const pendingCandidates = (db, ourProductId) =>
  db.prepare(`SELECT * FROM candidates WHERE status = 'pending' AND our_product_id = ? ORDER BY confidence DESC`)
    .all(ourProductId);

export const getCandidate = (db, id) =>
  db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);

export const rejectCandidate = (db, id) =>
  db.prepare(`UPDATE candidates SET status = 'rejected' WHERE id = ?`).run(id);

/** Подтверждение: кандидат переезжает в отслеживаемые. */
export function confirmCandidate(db, id, userId) {
  const c = getCandidate(db, id);
  if (!c) return null;
  db.prepare(`UPDATE candidates SET status = 'confirmed' WHERE id = ?`).run(id);
  db.prepare(`
    INSERT INTO watched (our_product_id, marketplace, external_id, name, brand,
                         supplier, url, pack, confirmed_by, confirmed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (our_product_id, marketplace, external_id) DO UPDATE SET active = 1
  `).run(c.our_product_id, c.marketplace, c.external_id, c.name, c.brand,
         c.supplier, c.url, c.pack, userId, now());
  return c;
}

/* ---------- отслеживание ---------- */

export const activeWatched = (db, marketplace) =>
  marketplace
    ? db.prepare('SELECT * FROM watched WHERE active = 1 AND marketplace = ?').all(marketplace)
    : db.prepare('SELECT * FROM watched WHERE active = 1').all();

/**
 * Фиксирует замер цены. В историю пишет только при ИЗМЕНЕНИИ.
 * Возвращает {changed, prevKop} — по этому решаем, слать ли уведомление.
 */
export function recordPrice(db, watchedId, { priceKop, stock, pack }) {
  const w = db.prepare('SELECT last_price_kop FROM watched WHERE id = ?').get(watchedId);
  const prevKop = w?.last_price_kop ?? null;
  const changed = prevKop !== priceKop;

  db.prepare('UPDATE watched SET last_seen_at = ?, last_price_kop = ? WHERE id = ?')
    .run(now(), priceKop ?? null, watchedId);

  if (changed) {
    const unit = priceKop == null ? null : Math.round(priceKop / Math.max(1, pack || 1));
    db.prepare(`INSERT INTO price_history (watched_id, price_kop, unit_price_kop, stock, seen_at)
                VALUES (?, ?, ?, ?, ?)`)
      .run(watchedId, priceKop ?? null, unit, stock ?? null, now());
  }
  return { changed, prevKop };
}

export const priceHistory = (db, watchedId, limit = 50) =>
  db.prepare('SELECT * FROM price_history WHERE watched_id = ? ORDER BY seen_at DESC LIMIT ?')
    .all(watchedId, limit);
