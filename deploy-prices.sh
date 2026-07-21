#!/usr/bin/env bash
# Развёртывание сервиса поиска цен РЯДОМ с ботом карточек.
# Запускать в папке репозитория на сервере. Бота карточек НЕ трогает —
# собирается и перезапускается только сервис `prices`.
#
#   git pull
#   nano .env            # вписать PRICES_BOT_TOKEN (см. ниже)
#   bash deploy-prices.sh
set -e
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

# 1. Проверка настроек в .env
if ! grep -q '^PRICES_BOT_TOKEN=..*' .env 2>/dev/null; then
  echo "❌ В .env нет PRICES_BOT_TOKEN."
  echo "   Добавь строки (второй бот от @BotFather, НЕ токен бота карточек):"
  echo "     PRICES_BOT_TOKEN=<токен>"
  echo "     PRICES_ALLOWED_USERS=          # пусто = открыт всем; или id через запятую"
  echo "     PRICES_OZON_ENABLED=0          # включим после проверки ниже"
  exit 1
fi

echo "== 1/3 Собираю и запускаю сервис цен (только его) =="
$SUDO docker compose up -d --build prices

echo
echo "== 2/3 Логи (последние 20 строк) =="
$SUDO docker compose logs --tail=20 prices

echo
echo "== 3/3 Проверка Ozon с этого (российского) IP =="
echo "   (если сервер в РФ — Ozon должен открыться, в отличие от машины с VPN)"
$SUDO docker compose exec -T prices node probe-ozon.mjs || true

echo
echo "──────────────────────────────────────────────────────────────"
echo "Дальше по итогу probe выше:"
echo "  • Ozon открылся и виден бейдж «Возврат НДС» → включаем Ozon:"
echo "      sed -i 's/^PRICES_OZON_ENABLED=.*/PRICES_OZON_ENABLED=1/' .env"
echo "      $SUDO docker compose up -d prices"
echo "  • Ozon дал 403/редирект → пришли вывод probe, разберёмся."
echo "  • Бот карточек всё это время работает как работал — его не трогали."
