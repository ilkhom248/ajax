import type { Tool } from "./types.js";
import Anthropic from "@anthropic-ai/sdk";

// Кодер работает на более сильной модели — меньше багов в коде.
// Поменять модель можно здесь (напр. claude-opus-4-8, если нет доступа к 5.5).
const CODER_MODEL = "claude-opus-5-5";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const CODER_SYSTEM = `Ты — Кодер проекта «Аякс» (Telegram-бот на TypeScript, ESM, Node 20+).
Пиши ГОТОВЫЙ к вставке код по правилам проекта:
- Новый инструмент — файл src/tools/<имя>.ts, экспортирует объект Tool (из "./types.js") вида { spec, run }.
  Интерфейс: interface Tool { spec: Anthropic.Tool; run: (input: any) => Promise<unknown>; }
- spec = { name, description, input_schema: { type: "object", properties: {...}, required: [...] } }.
  run = async (input) => объект (он вернётся модели как JSON).
- Во ВСЕХ относительных импортах пиши расширение .js: import { Tool } from "./types.js";
  import { pool } from "../store.js". Без .js сборка на Railway упадёт.
- База доступна так: import { pool } from "../store.js"; затем pool.query(...).
- Ключи НИКОГДА не вписывай в код. Бери их из process.env.ИМЯ и отдельно укажи, какую переменную
  Ильхом должен добавить в Railway → Variables.
- Используй глобальный fetch (он есть в Node 20). Новые npm-пакеты не добавляй без крайней нужды.
- Код должен проходить строгую проверку типов TypeScript.
Формат ответа:
1) Полный путь файла и полный его код, без пропусков.
2) Отдельно — ровно две строки для src/tools/index.ts: строка import и строка в массив tools.
3) Если нужен ключ — одной строкой, какую переменную добавить в Railway.
Пиши компактно, без лишних объяснений.`;

type CoderInput = { task: string };

export const writeCodeTool: Tool = {
  spec: {
    name: "write_code",
    description:
      "Написать готовый к вставке код для проекта Аякса. Внутри работает более сильная модель, " +
      "поэтому используй этот инструмент каждый раз, когда Ильхом просит написать новый инструмент " +
      "или любой код для бота. Передай задачу словами: что за инструмент, что он делает, какие входы " +
      "и выходы, какой ключ нужен (если нужен).",
    input_schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Задача на код, словами. Чем конкретнее, тем лучше результат.",
        },
      },
      required: ["task"],
    },
  },
  run: async (input) => {
    const { task } = input as CoderInput;
    const resp = await anthropic.messages.create({
      model: CODER_MODEL,
      max_tokens: 2500,
      system: CODER_SYSTEM,
      messages: [{ role: "user", content: task }],
    });
    const code = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return { model: CODER_MODEL, code };
  },
};
