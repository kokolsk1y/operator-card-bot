// Хранилище на встроенном node:sqlite — без нативных зависимостей и сборки.
// Требует Node 22+, поэтому сервис цен едет на своём образе (node:24-alpine),
// отдельно от бота карточек с его Node 20, rembg и chromium.
//
// Модель РАЗОВАЯ: храним только список товаров пользователя. Результаты поиска
// эфемерны — показали и забыли, каждый /проверить ищет заново. Ни кандидатов,
// ни отслеживания, ни истории цен: заказчик просил простой инструмент, а не
// систему мониторинга.
//
// ВАЖНО ПРО ДЕПЛОЙ: файл БД на volume, иначе список товаров умрёт при
// пересборке образа. Деньги — в КОПЕЙКАХ (INTEGER). Даты — ISO-строки UTC.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  db.exec('PRAGMA journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id             INTEGER PRIMARY KEY,
      name           TEXT    NOT NULL,
      article        TEXT,
      brand          TEXT,
      price_kop      INTEGER NOT NULL,           -- наша закупочная, за ШТУКУ
      price_has_vat  INTEGER NOT NULL DEFAULT 0, -- закупочная указана с НДС?
      vat_rate       INTEGER,                    -- ставка НДС нашего товара, %
      owner_id       INTEGER NOT NULL,           -- telegram user_id
      created_at     TEXT    NOT NULL,
      last_checked_at TEXT,                       -- когда последний раз искали
      last_found     INTEGER,                     -- сколько нашли в прошлый раз
      last_deals     INTEGER                      -- из них дешевле нашей
    );
    CREATE INDEX IF NOT EXISTS idx_products_owner ON products(owner_id);
  `);

  return db;
}

const now = () => new Date().toISOString();

export function addProduct(db, { name, article, brand, priceKop, priceHasVat = false, vatRate, ownerId }) {
  const r = db.prepare(`
    INSERT INTO products (name, article, brand, price_kop, price_has_vat, vat_rate, owner_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, article ?? null, brand ?? null, priceKop,
         priceHasVat ? 1 : 0, vatRate ?? null, ownerId, now());
  return Number(r.lastInsertRowid);
}

export const listProducts = (db, ownerId) =>
  db.prepare('SELECT * FROM products WHERE owner_id = ? ORDER BY id').all(ownerId);

/** Товар с проверкой владельца — чтобы по чужому id ничего не отдать/удалить. */
export const getProduct = (db, id, ownerId) =>
  db.prepare('SELECT * FROM products WHERE id = ? AND owner_id = ?').get(id, ownerId);

export function deleteProduct(db, id, ownerId) {
  const r = db.prepare('DELETE FROM products WHERE id = ? AND owner_id = ?').run(id, ownerId);
  return r.changes > 0;
}

/** Запоминает итог последнего поиска — чтобы /list был информативным. */
export function recordCheck(db, id, { found, deals }) {
  db.prepare('UPDATE products SET last_checked_at = ?, last_found = ?, last_deals = ? WHERE id = ?')
    .run(now(), found, deals, id);
}
