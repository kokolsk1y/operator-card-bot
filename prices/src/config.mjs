// Настройки сервиса. Всё через переменные окружения.
//
// ВАЖНО: репозиторий operator-card-bot ПУБЛИЧНЫЙ. Ни токена, ни логинов,
// ни куки в файлах быть не должно — только env и volume на сервере.

const int = (v, def) => (v == null || v === '' ? def : parseInt(v, 10));

export const config = {
  /** Токен ОТДЕЛЬНОГО бота. Не тот, что у генератора карточек. */
  botToken: process.env.PRICES_BOT_TOKEN || '',

  /**
   * Кто имеет право пользоваться, telegram user_id через запятую.
   * У бота карточек авторизации нет вообще — здесь так нельзя: бот знает
   * закупочные цены компании, это коммерческая тайна.
   */
  allowedUsers: (process.env.PRICES_ALLOWED_USERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean).map(Number),

  /** Файл БД. На сервере обязан лежать на volume, иначе умрёт при пересборке. */
  dbPath: process.env.PRICES_DB_PATH || './data/prices.db',

  /** Как часто проверять цены по списку отслеживания, минут. */
  checkEveryMin: int(process.env.PRICES_CHECK_EVERY_MIN, 20),

  /** Как часто искать новых кандидатов, часов. Поиск дорогой и ловит 429. */
  searchEveryHours: int(process.env.PRICES_SEARCH_EVERY_HOURS, 24),

  /**
   * Пускать ли предложения без возврата НДС.
   * По умолчанию да — но в уведомлении это будет видно, и считается
   * такое предложение по полной цене, без вычета.
   */
  allowNoVatReturn: process.env.PRICES_ALLOW_NO_VAT_RETURN !== '0',
};

export function assertConfig() {
  const problems = [];
  if (!config.botToken) problems.push('PRICES_BOT_TOKEN не задан');
  if (!config.allowedUsers.length) {
    problems.push('PRICES_ALLOWED_USERS не задан — бот знает закупочные цены, пускать всех нельзя');
  }
  if (problems.length) {
    throw new Error(`Не настроено:\n  - ${problems.join('\n  - ')}`);
  }
}
