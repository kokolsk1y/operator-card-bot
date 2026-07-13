#!/usr/bin/env bash
# Развёртывание бота операторов на Linux-сервере.
# Запускать ИЗ папки репозитория, под root (или через sudo):
#   git clone https://github.com/kokolsk1y/operator-card-bot.git
#   cd operator-card-bot
#   sudo bash deploy.sh
set -e

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "== 1/3 Docker =="
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден — устанавливаю..."
  curl -fsSL https://get.docker.com | $SUDO sh
else
  echo "Docker уже есть: $(docker --version)"
fi

echo ""
echo "== 2/3 Токен бота =="
if [ ! -f .env ]; then
  read -rp "Вставь токен бота от @BotFather и нажми Enter: " TOK
  printf 'BOT_TOKEN=%s\n' "$TOK" > .env
  echo ".env создан."
else
  echo ".env уже есть — пропускаю (токен не меняю)."
fi

echo ""
echo "== 3/3 Сборка и запуск =="
echo "Первый раз это ~10-15 минут (качается модель ~1 ГБ и chromium). Дальше — секунды."
$SUDO docker compose up -d --build

echo ""
echo "======================================================"
echo "✅ Готово. Бот запускается."
$SUDO docker compose ps
echo ""
echo "Полезное:"
echo "  Логи:        $SUDO docker compose logs -f"
echo "  Перезапуск:  $SUDO docker compose restart"
echo "  Обновить:    git pull && $SUDO docker compose up -d --build"
echo "  Остановить:  $SUDO docker compose down"
echo "======================================================"
