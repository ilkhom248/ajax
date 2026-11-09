import type { Tool } from "./types.js";
import { huggingfaceTool } from "./huggingface.js";
import { registerSubagentTool } from "./subagents.js";
import { writeCodeTool } from "./coder.js";
import { getTime } from "./get_time.js";
import { searchGithub } from "./search_github.js";

// ЧТОБЫ ДОБАВИТЬ НОВЫЙ ИНСТРУМЕНТ:
// 1) создай новый файл в этой папке, напр. image.ts, и экспортируй из него Tool;
// 2) добавь импорт выше и строку в массив ниже. Больше ничего менять не нужно.
export const tools: Tool[] = [
  huggingfaceTool,
  registerSubagentTool,
  writeCodeTool,
  getTime,
  searchGithub,
];

export function findTool(name: string): Tool | undefined {
  return tools.find((t) => t.spec.name === name);
}
