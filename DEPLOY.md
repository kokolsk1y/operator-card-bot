# Деплой бота на сервер (24/7, без твоего ПК)

Цель — бот работает круглосуточно сам, без открытого окна и без твоего компьютера.

## Что нужно
- **VPS** (виртуальный сервер): Ubuntu 22.04, **2 ядра / 4 ГБ RAM / 40 ГБ диск**.
  Подойдут российские Timeweb Cloud, Aeza, Selectel (~300–500 ₽/мес, оплата картой РФ).
- Токен бота от @BotFather (уже есть).

## Установка (один раз)

Подключись к серверу по SSH и выполни:

```bash
# 1. Docker (если ещё нет)
curl -fsSL https://get.docker.com | sh

# 2. Забрать код из GitHub
git clone https://github.com/kokolsk1y/operator-card-bot.git
cd operator-card-bot

# 3. Прописать токен
cp .env.example .env
nano .env            # впиши BOT_TOKEN=...  (Ctrl+O, Enter, Ctrl+X)

# 4. Собрать и запустить (соберётся ~10–15 мин — качается модель ~1 ГБ и chromium)
docker compose up -d --build
```

Готово. Бот работает. Проверь в Telegram: `/start`.

## Управление

```bash
docker compose logs -f      # смотреть логи
docker compose restart      # перезапустить
docker compose down         # остановить
docker compose up -d --build   # обновить после git pull
```

- `restart: unless-stopped` в `docker-compose.yml` = бот сам поднимается после сбоя и после перезагрузки сервера.
- Готовые карточки / вырезанные фото складываются в папки на сервере (примонтированы наружу контейнера).

## Обновление кода

```bash
cd operator-card-bot
git pull
docker compose up -d --build
```

## Заметки
- Токен **не** хранится в образе — только в `.env` на сервере (в git не попадает).
- Модель вырезки — **birefnet** (качество). На CPU ~20–40 сек/фото; вырезка идёт в фоне, оператор не ждёт.
- Один сервер = один экземпляр бота. Параллельно на ПК запускать НЕ нужно (будет конфликт 409).
