import type { Tool } from "./types.js";
import Anthropic from "@anthropic-ai/sdk";

// Кодер работает на более сильной модели — меньше багов в коде.
// Поменять модель можно здесь (напр. claude-opus-4-8, если нет доступа к 5.5).
const CODER_MODEL = "claude-opus-5-5";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const CODER_SYSTEM = `Ты — Кодер проекта «Аякс» (Telegram-бот на TypeScript, ESM, Node 20+).
Пиши код по правилам проекта:
- Новый инструмент — файл src/tools/<имя>.ts, экспортирует объект Tool (из "./types.js") вида { spec, run }.
  Интерфейс: interface Tool { spec: Anthropic.Tool; run: (input: any) => Promise<unknown>; }
- spec = { name, description, input_schema: { type: "object", properties: {...}, required: [...] } }.
  run = async (input) => объект (он вернётся как JSON).
- Во ВСЕХ относительных импортах пиши расширение .js: import { Tool } from "./types.js";
  import { pool } from "../store.js". Без .js сборка на Railway упадёт.
- База: import { pool } from "../store.js"; затем pool.query(...).
- Ключи НИКОГДА не вписывай в код. Бери из process.env.ИМЯ.
- Используй глобальный fetch (есть в Node 20). Новые npm-пакеты не добавляй.
- Код должен проходить строгую проверку типов TypeScript.

ФОРМАТ ОТВЕТА — строго такой, с этими маркерами, и ничего кроме него.
В блоках НЕ используй тройные кавычки и markdown, только чистый код/текст:

@@@PATH@@@
src/tools/<имя>.ts
@@@MAIN@@@
<полный код файла, без пропусков>
@@@IMPORT@@@
<одна строка импорта для src/tools/index.ts>
@@@ARRAY@@@
<одна строка для массива tools, напр. "  myTool,">
@@@ENV@@@
<ИМЯ_ПЕРЕМЕННОЙ и короткое пояснение где взять ключ; или слово нет, если ключ не нужен>
@@@END@@@`;

export type CoderResult =
  | {
      kind: "code";
      path: string;
      mainCode: string;
      indexImport: string;
      indexArray: string;
      envVar: string | null;
    }
  | { kind: "raw"; text: string };

function stripFences(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
  }
  return t;
}

function section(text: string, from: string, to: string): string | null {
  const i = text.indexOf(from);
  if (i === -1) return null;
  const start = i + from.length;
  const j = to ? text.indexOf(to, start) : text.length;
  const end = j === -1 ? text.length : j;
  return text.slice(start, end).trim();
}

function parseCoder(text: string): CoderResult {
  const path = section(text, "@@@PATH@@@", "@@@MAIN@@@");
  const mainCode = section(text, "@@@MAIN@@@", "@@@IMPORT@@@");
  const indexImport = section(text, "@@@IMPORT@@@", "@@@ARRAY@@@");
  const indexArray = section(text, "@@@ARRAY@@@", "@@@ENV@@@");
  const envRaw = section(text, "@@@ENV@@@", "@@@END@@@");

  if (path && mainCode && indexImport && indexArray) {
    const env = envRaw && !/^нет$|^none$|^no$/i.test(envRaw.trim()) ? envRaw.trim() : null;
    return {
      kind: "code",
      path: stripFences(path),
      mainCode: stripFences(mainCode),
      indexImport: stripFences(indexImport),
      indexArray: stripFences(indexArray),
      envVar: env,
    };
  }
  return { kind: "raw", text };
}

type CoderInput = { task: string };

export const writeCodeTool: Tool = {
  spec: {
    name: "write_code",
    description:
      "Написать готовый к вставке код для проекта Аякса. Внутри работает более сильная модель, " +
      "поэтому используй этот инструмент каждый раз, когда Ильхом просит написать новый инструмент " +
      "или любой код для бота. Код отправляется Ильхому отдельными сообщениями автоматически — " +
      "сам не повторяй его в ответе. Передай задачу словами: что за инструмент, что делает, " +
      "какие входы и выходы, какой ключ нужен (если нужен).",
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
      max_tokens: 3000,
      system: CODER_SYSTEM,
      messages: [{ role: "user", content: task }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return parseCoder(text);
  },
};
