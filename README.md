# ◆ Опал — мессенджер из жидкого стекла

Полноценный веб-мессенджер в стиле «жидкого стекла» Apple: приватные чаты, фото, файлы, голосовые сообщения, всё в реальном времени.

![стек](https://img.shields.io/badge/UI-liquid%20glass-8fffb0) ![node](https://img.shields.io/badge/node-%E2%89%A522.13-green)

## Что умеет

- **Регистрация по юзернейму и паролю** — юзернеймы уникальны, пароли хранятся как scrypt-хэши с солью
- **Профиль с аватаркой**, именем и «о себе»; аватарки по клику, дефолтная — градиент с инициалом
- **Приватные чаты** с любым пользователем — поиск по юзернейму и имени
- **Реальное время** на WebSocket: доставка сообщений, «печатает…», онлайн-статусы, непрочитанные
- **Фото** — с превью в чате, лайтбоксом, скачиванием; большие сжимаются на клиенте
- **Файлы** — до 60 МБ, с иконкой и размером
- **Голосовые** — запись с микрофона, волновая дорожка, плеер с прогрессом
- **Звонки 1:1 (WebRTC, P2P)** — голос, камера и демонстрация экрана:
  - экран до **60 FPS** (`contentHint: motion`, `maintain-framerate`, битрейт до 6.5 Мбит/с) со звуком системы, подмешанным к микрофону
  - **оба участника** могут одновременно передавать видео (у каждого свой видео-трек)
  - живой счётчик FPS входящего потока, рингтоны, «занято», история таймера
  - медиа идёт напрямую между браузерами (STUN Google), сигналинг — через WebSocket сервера
- **Ответы на сообщения** (цитаты), удаление своих, галочки прочтения ✓/✓✓
- **Эмодзи-панель**, drag&drop файлов, вставка картинок из буфера (Ctrl+V)
- **Мгновенная отправка** — оптимистичный UI: сообщение появляется до ответа сервера
- Уведомления на рабочем столе, разные звуки на отправку и получение, счётчик в заголовке вкладки
- Адаптив: на телефоне — один экран со слайдами, на десктопе — две панели

## Стек

- **Node.js ≥ 22.13** (используется встроенный `node:sqlite` — никакой нативной компиляции)
- **ws** — единственная зависимость (WebSocket)
- Фронт — чистые HTML/CSS/JS без фреймворков и сборки
- Данные — SQLite-файл `data/opal.db` (WAL-режим), файлы — в `uploads/`

## Запуск локально

```bash
npm install
npm start
# → http://localhost:3000
```

Переменные окружения: `PORT` (по умолчанию 3000), `HOST` (по умолчанию 0.0.0.0).

Тесты (поднимут тестовых пользователей и прогонят весь API + WebSocket):

```bash
node test.js
```

## Деплой за 10 минут (без своего сервера)

В проекте есть `Dockerfile` — подойдёт любая платформа с поддержкой Docker. Быстрые варианты:

### Railway (рекомендую: WebSocket + постоянный диск, деплой из GitHub)

1. Залей проект в GitHub-репозиторий
2. [railway.com](https://railway.com) → New Project → Deploy from GitHub repo
3. В сервисе: Settings → Volumes → New Volume, mount path `/opal-data`
4. railway.com выдаст публичный домен (Settings → Networking → Generate Domain) — HTTPS из коробки
5. Друзья заходят на этот адрес и регистрируются. Голосовые работают — это HTTPS

Переменная `PORT` задаётся платформой автоматически. База и файлы живут в томе `/opal-data` и переживают редеплои.

### Render

- New → Web Service → подключи репозиторий → Environment: Docker
- На бесплатном тарифе диск эфемерный и сервис засыпает: сообщения будут теряться при пересборках/пробуждении. Для «по-быстрому показать» ок, для постоянного чата нужен платный план или Railway.

### Свой VPS

Полная инструкция в разделе ниже (systemd + nginx + certbot).

## Деплой на сервер (Ubuntu + nginx + HTTPS)

1. Скопируй папку на сервер, поставь Node 22+:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
npm install --omit=dev
```

2. systemd-сервис `/etc/systemd/system/opal.service`:

```ini
[Unit]
Description=Opal messenger
After=network.target

[Service]
WorkingDirectory=/opt/opal
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=3000
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now opal
```

3. nginx-конфиг с проксированием WebSocket:

```nginx
server {
    listen 443 ssl http2;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    client_max_body_size 64m;          # под размер загружаемых файлов

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
    }
}
```

Сертификат: `sudo certbot --nginx -d chat.example.com`. Фронт сам переключится на `wss://`.

## Резервные копии

Всё состояние — два места: `data/opal.db` (база, вместе с `-wal`/`-shm`) и папка `uploads/`. Бэкап — просто скопировать их.

## Безопасность

- Пароли — scrypt со случайной солью, сравнение в constant-time
- Сессии — httpOnly-cookie на 30 дней, токены в БД
- Rate-limit на регистрацию/логин
- Файлы сохраняются со случайными именами, опасные расширения (html/svg) отдаются на скачивание, путь загрузки проверяется (path traversal закрыт)
- Текст сообщений рендерится как текст (XSS исключён), ссылки — с `rel="noopener nofollow"`

## Структура

```
server.js        — HTTP API + WebSocket + статика
db.js            — схема SQLite
public/
  index.html     — каркас
  styles.css     — вся дизайн-система «жидкого стекла»
  app.js         — клиент (realtime, медиа, голосовые)
  fonts/         — Unbounded + Onest локально (работает без интернета)
data/            — база SQLite (создаётся сама)
uploads/         — файлы и аватарки (создаётся сама)
test.js          — интеграционные тесты
```
