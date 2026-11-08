import { Bot } from "grammy";
import Anthropic from "@anthropic-ai/sdk";

// ---- Конфигурация (всё берётся из переменных окружения на Railway) ----
const BOT_TOKEN = required("BOT_TOKEN");
const ANTHROPIC_API_KEY = required("ANTHROPIC_API_KEY");
const OWNER_ID = Number(required("OWNER_ID")); // твой Telegram ID — бот отвечает только тебе

const MODEL = "claude-sonnet-5-5"; // мозг Джарвиса
const MAX_TURNS = 20; // сколько последних реплик помним (память в ОЗУ, обнуляется при перезапуске)

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Не задана переменная окружения: ${name}`);
  return v;
}

// ---- Личность Джарвиса ----
const SYSTEM_PROMPT = `Ты — Аякс, личный ассистент-оркестратор Ильхома.
Общаешься по-русски, кратко и по делу, структурированно.
Ты помогаешь вести проекты и со временем будешь управлять субагентами.
Если задача выходит за твои текущие возможности — честно скажи об этом,
не выдумывай результаты. Прежде чем предлагать действия, стоящие денег
или подключения новых сервисов, спрашивай подтверждения.`;

// ---- Клиенты ----
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const bot = new Bot(BOT_TOKEN);

// ---- Память разговора (пока в оперативной памяти) ----
type Turn = { role: "user" | "assistant"; content: string };
const history: Turn[] = [];

// ---- Защита: отвечаем только владельцу ----
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== OWNER_ID) {
    await ctx.reply("Доступ только для владельца.");
    return;
  }
  await next();
});

// ---- Команды ----
bot.command("start", (ctx) =>
  ctx.reply("Аякс на связи. Пиши текстом — я отвечу. /reset очистит память разговора.")
);

bot.command("reset", (ctx) => {
  history.length = 0;
  return ctx.reply("Память разговора очищена.");
});

// ---- Основной обработчик текста ----
bot.on("message:text", async (ctx) => {
  const userText = ctx.message.text;
  history.push({ role: "user", content: userText });

  await ctx.replyWithChatAction("typing");

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: history.slice(-MAX_TURNS),
    });

    // Собираем текст из ответа модели
    const reply = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    const finalReply = reply || "(пустой ответ)";
    history.push({ role: "assistant", content: finalReply });
    await ctx.reply(finalReply);
  } catch (err) {
    console.error("Ошибка вызова Claude:", err);
    await ctx.reply("Сбой при обращении к модели. Попробуй ещё раз.");
  }
});

// ---- Запуск ----
bot.catch((err) => console.error("Ошибка бота:", err));
bot.start();
console.log("Ajax запущен.");
