import { Bot } from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import { initDb, clearMemory, addTurn, getRecentTurns, listSubagents } from "./store.js";
import { tools, findTool } from "./tools/index.js";

// ---- Конфигурация ----
const BOT_TOKEN = required("BOT_TOKEN");
const ANTHROPIC_API_KEY = required("ANTHROPIC_API_KEY");
const OWNER_ID = Number(required("OWNER_ID"));

const MODEL = "claude-sonnet-5-5"; // мозг Аякса
const MAX_TURNS = 20;
const MAX_STEPS = 5;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Не задана переменная окружения: ${name}`);
  return v;
}

const SYSTEM_PROMPT = `Ты — Аякс, личный ассистент-оркестратор Ильхома.
Общаешься по-русски, кратко и по делу, структурированно.
У тебя есть постоянная память: ты помнишь прошлые разговоры, не говори, что памяти нет.
У тебя есть инструменты: search_huggingface (поиск моделей/датасетов/Spaces на Hugging Face)
и register_subagent (создать субагента — роль поверх существующих инструментов).
Используй их, когда уместно. Субагент умеет только то, что умеют существующие инструменты —
новой способности он не даёт, честно говори об этом. Структуру можно посмотреть командой /tree.
Если задача выходит за твои возможности — честно скажи. Прежде чем предлагать действия,
стоящие денег или подключение новых сервисов, спрашивай подтверждения.`;

// ---- Клиенты ----
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const toolSpecs = tools.map((t) => t.spec);
const bot = new Bot(BOT_TOKEN);

// ---- Агентный цикл ----
async function runAgent(userText: string, onThinking: () => Promise<void>): Promise<string> {
  const prior = await getRecentTurns(MAX_TURNS);
  const messages: Anthropic.MessageParam[] = [...prior, { role: "user", content: userText }];
  let finalReply = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: toolSpecs,
      messages,
    });

    if (resp.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: resp.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of resp.content) {
        if (block.type === "tool_use") {
          await onThinking();
          const tool = findTool(block.name);
          let out: unknown;
          try {
            out = tool ? await tool.run(block.input) : { error: `Неизвестный инструмент: ${block.name}` };
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
      continue;
    }

    finalReply = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    break;
  }

  if (!finalReply) finalReply = "Не удалось завершить за отведённые шаги. Переформулируй?";
  await addTurn("user", userText);
  await addTurn("assistant", finalReply);
  return finalReply;
}

// ---- Дерево структуры ----
async function renderTree(): Promise<string> {
  const subs = await listSubagents();
  const lines: string[] = ["🤖 Аякс", "├─ 🔧 Инструменты:"];
  tools.forEach((t, i) => {
    const last = i === tools.length - 1;
    lines.push(`│  ${last ? "└─" : "├─"} ${t.spec.name}`);
  });
  if (subs.length === 0) {
    lines.push("└─ 👥 Субагенты: пока нет");
  } else {
    lines.push("└─ 👥 Субагенты:");
    subs.forEach((s, i) => {
      const last = i === subs.length - 1;
      lines.push(`   ${last ? "└─" : "├─"} ${s.name} — ${s.description} [${s.status}]`);
    });
  }
  return lines.join("\n");
}

// ---- Защита: только владелец ----
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== OWNER_ID) {
    await ctx.reply("Доступ только для владельца.");
    return;
  }
  await next();
});

// ---- Команды ----
bot.command("start", (ctx) =>
  ctx.reply("Аякс на связи. Пиши текстом — я отвечу. /tree покажет структуру, /reset очистит память.")
);
bot.command("reset", async (ctx) => {
  await clearMemory();
  await ctx.reply("Память разговора очищена.");
});
bot.command("tree", async (ctx) => ctx.reply(await renderTree()));
bot.hears(/^(дерево|структура)$/i, async (ctx) => ctx.reply(await renderTree()));

// ---- Обычные сообщения ----
bot.on("message:text", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try {
    const reply = await runAgent(ctx.message.text, async () => {
      await ctx.replyWithChatAction("typing");
    });
    await ctx.reply(reply);
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

await initDb();
console.log("Ajax запущен.");
await startWithRetry();
