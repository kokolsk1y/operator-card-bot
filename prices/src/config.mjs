// Настройки сервиса. Всё через переменные окружения.
//
// ВАЖНО: репозиторий operator-card-bot ПУБЛИЧНЫЙ. Ни токена, ни логинов,
// ни куки в файлах быть не должно — только env и volume на сервере.

export const config = {
  /** Токен ОТДЕЛЬНОГО бота. Не тот, что у генератора карточек. */
  botToken: process.env.PRICES_BOT_TOKEN || '',

  /**
   * Кто имеет право пользоваться, telegram user_id через запятую.
   * ПУСТО = открытый доступ для всех.
   *
   * Открытый режим безопасен только потому, что данные разделены по владельцу:
   * каждый видит и ищет ТОЛЬКО свои товары. Чужие закупочные цены не покажутся
   * и чужой поиск не запустится. Если добавляешь новую команду — проверь, что
   * она фильтрует по ctx.from.id, иначе откроешь коммерческую тайну наружу.
   */
  allowedUsers: (process.env.PRICES_ALLOWED_USERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean).map(Number),

  /** Файл БД. На сервере обязан лежать на volume, иначе умрёт при пересборке. */
  dbPath: process.env.PRICES_DB_PATH || './data/prices.db',
};

export function assertConfig() {
  if (!config.botToken) throw new Error('Не настроено: PRICES_BOT_TOKEN не задан');

  if (!config.allowedUsers.length) {
    console.warn(
      '⚠️  PRICES_ALLOWED_USERS пуст — бот открыт для всех.\n' +
      '   Данные разделены по владельцу, чужого никто не увидит,\n' +
      '   но любой сможет завести свои товары и запускать поиск.\n' +
      '   Закрыть: PRICES_ALLOWED_USERS=<твой user_id>');
  }
}
