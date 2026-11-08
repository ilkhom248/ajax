import type Anthropic from "@anthropic-ai/sdk";

// Каждый инструмент Аякса — это пара: описание для модели (spec)
// и функция, которая его выполняет (run).
export interface Tool {
  spec: Anthropic.Tool;
  run: (input: any) => Promise<unknown>;
}
