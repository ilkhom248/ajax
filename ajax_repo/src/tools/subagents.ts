import type { Tool } from "./types.js";
import { addSubagent } from "../store.js";

type RegisterInput = { name: string; description: string; tools?: string[] };

export const registerSubagentTool: Tool = {
  spec: {
    name: "register_subagent",
    description:
      "Зарегистрировать нового субагента — роль поверх уже существующих инструментов. " +
      "Используй, когда Ильхом просит создать субагента. После регистрации субагент " +
      "появляется в дереве (команда /tree). Важно: субагент умеет только то, что умеют " +
      "перечисленные существующие инструменты; новых способностей он не даёт.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Короткое имя субагента" },
        description: { type: "string", description: "Что он делает и как думает" },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Какие существующие инструменты ему разрешены, напр. search_huggingface",
        },
      },
      required: ["name", "description"],
    },
  },
  run: async (input) => {
    const { name, description, tools } = input as RegisterInput;
    const id = await addSubagent(name, description, tools ?? []);
    return { ok: true, id, message: `Субагент «${name}» зарегистрирован и добавлен в дерево.` };
  },
};
