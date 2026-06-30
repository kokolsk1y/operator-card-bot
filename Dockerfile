# Образ бота операторов: node + python + rembg(birefnet) + chromium(puppeteer).
# Собрать:   docker build -t operator-bot .
# Запустить: docker run -d --restart=unless-stopped -e BOT_TOKEN=ВАШ_ТОКЕН operator-bot
FROM node:20-bullseye

# ── системные библиотеки для chromium (puppeteer) + python ──
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
      ca-certificates fonts-liberation \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libcairo2 libatspi2.0-0 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── python-зависимости (вырезка фона) ──
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

# ── предзагрузка модели birefnet (~1 ГБ), чтобы первый запуск не ждал ──
RUN python3 -c "from rembg import new_session; new_session('birefnet-general')"

# ── node-зависимости (+ chromium для puppeteer скачается сюда) ──
COPY package.json ./
RUN npm install --omit=dev

# ── код и ресурсы ──
COPY . .

ENV NODE_ENV=production
# токен передаётся через переменную окружения BOT_TOKEN
CMD ["node", "index.mjs"]
