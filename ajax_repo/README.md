# Jarvis — шаг 1 (скелет)

Telegram-бот, который принимает текст и отвечает через Claude. Слушается только владельца.
Голос и постоянная память — следующий шаг.

## Запуск на Railway

1. Залей эти файлы в свой GitHub-репозиторий.
2. На Railway: **New Project → Deploy from GitHub repo** → выбери репозиторий.
3. Открой вкладку **Variables** и добавь три переменные:
   - `BOT_TOKEN` — токен от BotFather
   - `ANTHROPIC_API_KEY` — ключ с console.anthropic.com
   - `OWNER_ID` — твой Telegram ID (узнать: напиши боту @userinfobot)
4. В **Settings → Build** Railway сам поймёт Node. Команда старта: `npm run build && npm start`
   (если не подхватит — пропиши её вручную в поле Start Command).
5. Deploy. В логах должно появиться `Jarvis запущен.`
6. Напиши своему боту в Telegram `/start`.

## Команды бота

- `/start` — проверка связи
- `/reset` — очистить память разговора

## Локальный запуск (если захочешь на компе)

```bash
npm install
cp .env.example .env   # впиши свои значения
npm run dev
```

## Что дальше (шаг 2)

- Распознавание голосовых → текст
- Постоянная память в базе (чтобы переживала перезапуск)
