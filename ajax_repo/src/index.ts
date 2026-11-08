import { Bot } from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";

// ---- Конфигурация (всё берётся из переменных окружения на Railway) ----
const BOT_TOKEN = required("BOT_TOKEN");
const ANTHROPIC_API_KEY = required("ANTHROPIC_API_KEY");
const OWNER_ID = Number(required("OWNER_ID")); // твой Telegram ID — бот отвечает только тебе
const DATABASE_URL = process.env.DATABASE_URL; // появится после привязки базы на Railway

const MODEL = "claude-sonnet-5-5"; // мозг Аякса
const MAX_TURNS = 20; // сколько последних реплик берём в контекст

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Не задана переменная окружения: ${name}`);
  return v;
}

// ---- Личность Аякса ----
const SYSTEM_PROMPT = `Ты — Аякс, личный ассистент-оркестратор Ильхома.
Общаешься по-русски, кратко и по делу, структурированно.
У тебя есть постоянная память: ты помнишь прошлые разговоры, поэтому
не говори, что памяти нет. Ты помогаешь вести проекты и со временем
будешь управлять субагентами. Если задача выходит за твои текущие
возможности — честно скажи об этом, не выдумывай результаты. Прежде
чем предлагать действия, стоящие денег или подключения новых
сервисов, спрашивай подтверждения.`;

// ---- Клиенты ----
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const bot = new Bot(BOT_TOKEN);

// ---- Слой памяти ----
// Если база подключена — храним в Postgres (переживает перезапуск).
// Если нет — временно в оперативке, чтобы бот всё равно работал.
type Turn = { role: "user" | "assistant"; content: string };

const pool = DATABASE_URL
  ? new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes(".railway.internal")
        ? undefined
        : { rejectUnauthorized: false },
    })
  : null;

const ramHistory: Turn[] = []; // запасной вариант, если базы нет

async function initMemory() {
  console.log("DATABASE_URL задан:", Boolean(DATABASE_URL)); // диагностика
  if (!pool) {
    console.warn("DATABASE_URL не задан — память в оперативке (забудется при перезапуске).");
    return;
  }
  pool.on("error", (e) => console.error("Ошибка пула БД:", e));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("Память в Postgres готова.");
}

async function addTurn(role: Turn["role"], content: string) {
  if (pool) {
    await pool.query("INSERT INTO messages (role, content) VALUES ($1, $2)", [role, content]);
  } else {
    ramHistory.push({ role, content });
  }
}

async function getRecentTurns(limit: number): Promise<Turn[]> {
  if (pool) {
    const res = await pool.query<Turn>(
      "SELECT role, content FROM messages ORDER BY id DESC LIMIT $1",
      [limit]
    );
    return res.rows.reverse(); // в хронологическом порядке
  }
  return ramHistory.slice(-limit);
}

async function clearMemory() {
  if (pool) {
    await pool.query("DELETE FROM messages");
  } else {
    ramHistory.length = 0;
  }
}

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

bot.command("reset", async (ctx) => {
  await clearMemory();
  await ctx.reply("Память разговора очищена.");
});

// ---- Основной обработчик текста ----
bot.on("message:text", async (ctx) => {
  const userText = ctx.message.text;
  await ctx.replyWithChatAction("typing");

  try {
    await addTurn("user", userText);
    const turns = await getRecentTurns(MAX_TURNS);

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: turns,
    });

    const reply = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    const finalReply = reply || "(пустой ответ)";
    await addTurn("assistant", finalReply);
    await ctx.reply(finalReply);
  } catch (err) {
    console.error("Ошибка обработки сообщения:", err);
    await ctx.reply("Сбой при обработке. Попробуй ещё раз.");
  }
});

// ---- Устойчивый запуск polling ----
// drop_pending_updates сбрасывает очередь Telegram; при 409 (второй экземпляр
// ещё не погас после передеплоя) не падаем, а ждём и переподключаемся.
async function startWithRetry(attempt = 1): Promise<void> {
  try {
    await bot.start({
      drop_pending_updates: true,
      onStart: () => console.log("Polling начат."),
    });
  } catch (err: any) {
    const code = err?.error_code ?? err?.payload?.error_code;
    if (code === 409 && attempt <= 15) {
      console.warn(`409 Conflict (попытка ${attempt}) — жду 6с и переподключаюсь...`);
      await new Promise((r) => setTimeout(r, 6000));
      try { await bot.stop(); } catch {}
      return startWithRetry(attempt + 1);
    }
    throw err;
  }
}

bot.catch((err) => console.error("Ошибка бота:", err));

await initMemory();
console.log("Ajax запущен.");
await startWithRetry();
