import { Bot } from "grammy";
import type { Context } from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import { initDb, clearMemory, addTurn, getRecentTurns, listSubagents } from "./store.js";
import { tools, findTool } from "./tools/index.js";
import type { CoderResult } from "./tools/coder.js";

// ---- Конфигурация ----
const BOT_TOKEN = required("BOT_TOKEN");
const ANTHROPIC_API_KEY = required("ANTHROPIC_API_KEY");
const OWNER_ID = Number(required("OWNER_ID"));

const MODEL = "claude-sonnet-5-5"; // мозг Аякса (чат)
const MAX_TURNS = 20;
const MAX_STEPS = 5;
const TG_LIMIT = 4000; // предел длины одного сообщения Telegram (с запасом)

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Не задана переменная окружения: ${name}`);
  return v;
}

const SYSTEM_PROMPT = `Ты — Аякс, личный ассистент-оркестратор Ильхома.
Общаешься по-русски, кратко и по делу, структурированно.
У тебя есть постоянная память: ты помнишь прошлые разговоры, не говори, что памяти нет.

Инструменты:
- search_huggingface — поиск моделей/датасетов/Spaces на Hugging Face.
- register_subagent — создать субагента (роль поверх существующих инструментов). Субагент
  умеет только то, что умеют существующие инструменты; новой способности он не даёт — говори
  об этом честно. Структуру смотри командой /tree.
- write_code — написать готовый к вставке код для проекта. Внутри работает более сильная
  модель. Вызывай его КАЖДЫЙ раз, когда Ильхом просит написать новый инструмент или любой код.
  Код отправляется Ильхому автоматически отдельными сообщениями — НЕ повторяй его в ответе и
  ничего не дописывай после вызова.

Если задача выходит за твои возможности — честно скажи. Прежде чем предлагать платные
действия или подключение новых сервисов, спрашивай подтверждения.`;

// ---- Клиенты ----
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const toolSpecs = tools.map((t) => t.spec);
const bot = new Bot(BOT_TOKEN);

// ---- Агентный цикл ----
async function runAgent(
  userText: string,
  onThinking: () => Promise<void>
): Promise<{ reply: string; codeOutputs: CoderResult[] }> {
  const prior = await getRecentTurns(MAX_TURNS);
  const messages: Anthropic.MessageParam[] = [...prior, { role: "user", content: userText }];
  const codeOutputs: CoderResult[] = [];
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

          if (block.name === "write_code") {
            codeOutputs.push(out as CoderResult);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: "Код сгенерирован и отправлен Ильхому отдельными сообщениями. Не повторяй код.",
            });
          } else {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(out),
            });
          }
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

  if (!finalReply && codeOutputs.length === 0) {
    finalReply = "Не удалось завершить за отведённые шаги. Переформулируй?";
  }

  const note =
    codeOutputs.length > 0
      ? `Сгенерировал код: ${codeOutputs
          .map((c) => (c.kind === "code" ? c.path : "фрагмент"))
          .join(", ")}`
      : finalReply;
  await addTurn("user", userText);
  await addTurn("assistant", note);

  return { reply: finalReply, codeOutputs };
}

// ---- Отправка длинного текста по частям (без markdown, чтобы код не ломался) ----
async function sendLong(ctx: Context, text: string) {
  if (text.length <= TG_LIMIT) {
    await ctx.reply(text);
    return;
  }
  const lines = text.split("\n");
  let buf = "";
  for (const line of lines) {
    if ((buf ? buf.length + 1 : 0) + line.length > TG_LIMIT) {
      if (buf) {
        await ctx.reply(buf);
        buf = "";
      }
      if (line.length > TG_LIMIT) {
        for (let i = 0; i < line.length; i += TG_LIMIT) {
          await ctx.reply(line.slice(i, i + TG_LIMIT));
        }
      } else {
        buf = line;
      }
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) await ctx.reply(buf);
}

// ---- Отправка кода отдельными сообщениями ----
async function sendCode(ctx: Context, co: CoderResult) {
  if (co.kind === "raw") {
    await sendLong(ctx, co.text);
    return;
  }
  // 1) основной код
  await sendLong(ctx, co.mainCode);
  // 2) строки для index
  await ctx.reply(`${co.indexImport}\n\n${co.indexArray}`);
  // 3) ключ, если нужен
  if (co.envVar) {
    await ctx.reply(`🔑 Добавь в Railway → Variables:\n${co.envVar}`);
  }
  // 4) короткая инструкция — последним сообщением
  const steps = [
    `📌 Что сделать:`,
    `1. Создай файл ${co.path} и вставь первый код.`,
    `2. В src/tools/index.ts: строку импорта — вверх к другим import, строку ${co.indexArray.trim()} — в массив tools (это второе сообщение).`,
  ];
  if (co.envVar) steps.push(`3. Добавь переменную в Railway → Variables (третье сообщение).`);
  steps.push(`Коммить — Railway пересоберёт сам.`);
  await ctx.reply(steps.join("\n"));
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
    const { reply, codeOutputs } = await runAgent(ctx.message.text, async () => {
      await ctx.replyWithChatAction("typing");
    });
    if (codeOutputs.length > 0) {
      for (const co of codeOutputs) await sendCode(ctx, co);
    } else {
      await ctx.reply(reply);
    }
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
