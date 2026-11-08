import { Bot } from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";
 
// ---- Конфигурация ----
const BOT_TOKEN = required("BOT_TOKEN");
const ANTHROPIC_API_KEY = required("ANTHROPIC_API_KEY");
const OWNER_ID = Number(required("OWNER_ID"));
const DATABASE_URL = process.env.DATABASE_URL;
 
const MODEL = "claude-sonnet-5-5"; // мозг Аякса
const MAX_TURNS = 20; // сколько последних реплик берём в контекст
const MAX_STEPS = 5;  // предел шагов в одном цикле (защита от зацикливания)
 
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Не задана переменная окружения: ${name}`);
  return v;
}
 
// ---- Личность Аякса ----
const SYSTEM_PROMPT = `Ты — Аякс, личный ассистент-оркестратор Ильхома.
Общаешься по-русски, кратко и по делу, структурированно.
У тебя есть постоянная память: ты помнишь прошлые разговоры, не говори, что памяти нет.
У тебя есть инструмент search_huggingface — поиск моделей, датасетов и Spaces на Hugging Face.
Используй его, когда Ильхому нужно найти инструмент под задачу (озвучка, распознавание речи,
генерация текста/картинок и т.п.). После поиска не вываливай сырой список — коротко объясни,
что нашёл и что из этого подходит под его задачу, с ссылками. Если задача выходит за твои
возможности — честно скажи. Прежде чем предлагать действия, стоящие денег или подключение
новых сервисов, спрашивай подтверждения.`;
 
// ---- Клиенты ----
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const bot = new Bot(BOT_TOKEN);
 
// ---- Слой памяти (Postgres, с запасным вариантом в ОЗУ) ----
type Turn = { role: "user" | "assistant"; content: string };
 
const pool = DATABASE_URL
  ? new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes(".railway.internal")
        ? undefined
        : { rejectUnauthorized: false },
    })
  : null;
 
const ramHistory: Turn[] = [];
 
async function initMemory() {
  console.log("DATABASE_URL задан:", Boolean(DATABASE_URL));
  if (!pool) {
    console.warn("DATABASE_URL не задан — память в оперативке.");
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
    return res.rows.reverse();
  }
  return ramHistory.slice(-limit);
}
 
async function clearMemory() {
  if (pool) await pool.query("DELETE FROM messages");
  else ramHistory.length = 0;
}
 
// ---- Инструмент: разведчик по Hugging Face ----
const tools: Anthropic.Tool[] = [
  {
    name: "search_huggingface",
    description:
      "Поиск на Hugging Face Hub: модели, датасеты или Spaces по ключевым словам. " +
      "Возвращает топ результатов по числу скачиваний: id, скачивания, лайки, задача, ссылка.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Ключевые слова для поиска (англ. работает лучше)" },
        kind: {
          type: "string",
          enum: ["models", "datasets", "spaces"],
          description: "Что искать. По умолчанию models.",
        },
        task: {
          type: "string",
          description:
            "Необязательно, только для models: pipeline-тег, напр. text-to-speech, " +
            "automatic-speech-recognition, text-generation, text-to-image.",
        },
        limit: { type: "integer", description: "Сколько вернуть (1-10). По умолчанию 5." },
      },
      required: ["query"],
    },
  },
];
 
type HFInput = { query: string; kind?: string; task?: string; limit?: number };
 
async function searchHuggingFace(input: HFInput) {
  const kind = ["models", "datasets", "spaces"].includes(input.kind || "")
    ? (input.kind as string)
    : "models";
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
 
  const params = new URLSearchParams({
    search: input.query,
    sort: "downloads",
    direction: "-1",
    limit: String(limit),
  });
  if (kind === "models" && input.task) params.set("filter", input.task);
 
  const url = `https://huggingface.co/api/${kind}?${params.toString()}`;
  const res = await fetch(url, { headers: { "User-Agent": "ajax-bot" } });
  if (!res.ok) return { error: `Hugging Face API вернул ${res.status}` };
 
  const data = (await res.json()) as any[];
  const prefix = kind === "models" ? "" : `${kind}/`;
  const results = data.slice(0, limit).map((m) => {
    const id = m.id ?? m.modelId;
    return {
      id,
      downloads: m.downloads ?? null,
      likes: m.likes ?? null,
      task: m.pipeline_tag ?? null,
      sdk: m.sdk ?? undefined, // для Spaces
      updated: m.lastModified ?? null,
      url: `https://huggingface.co/${prefix}${id}`,
    };
  });
  return { kind, query: input.query, count: results.length, results };
}
 
async function runTool(name: string, input: unknown): Promise<unknown> {
  if (name === "search_huggingface") return searchHuggingFace(input as HFInput);
  return { error: `Неизвестный инструмент: ${name}` };
}
 
function textFrom(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
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
  ctx.reply("Аякс на связи. Пиши текстом — я отвечу. Умею искать на Hugging Face. /reset очистит память.")
);
 
bot.command("reset", async (ctx) => {
  await clearMemory();
  await ctx.reply("Память разговора очищена.");
});
 
// ---- Основной обработчик: агентный цикл с инструментами ----
bot.on("message:text", async (ctx) => {
  const userText = ctx.message.text;
  await ctx.replyWithChatAction("typing");
 
  try {
    const prior = await getRecentTurns(MAX_TURNS);
    const messages: Anthropic.MessageParam[] = [
      ...prior,
      { role: "user", content: userText },
    ];
 
    let finalReply = "";
 
    for (let step = 0; step < MAX_STEPS; step++) {
      const resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });
 
      if (resp.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: resp.content });
 
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of resp.content) {
          if (block.type === "tool_use") {
            await ctx.replyWithChatAction("typing");
            let out: unknown;
            try {
              out = await runTool(block.name, block.input);
            } catch (e) {
              out = { error: String(e) };
            }
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(out),
            });
          }
        }
        messages.push({ role: "user", content: toolResults });
        continue; // отдаём результаты модели и идём на новый круг
      }
 
      finalReply = textFrom(resp);
      break;
    }
 
    if (!finalReply) finalReply = "Не удалось завершить за отведённые шаги. Переформулируй?";
 
    // В память пишем только исходный вопрос и финальный ответ (без служебных tool-блоков)
    await addTurn("user", userText);
    await addTurn("assistant", finalReply);
    await ctx.reply(finalReply);
  } catch (err) {
    console.error("Ошибка обработки сообщения:", err);
    await ctx.reply("Сбой при обработке. Попробуй ещё раз.");
  }
});
 
// ---- Устойчивый запуск polling ----
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
