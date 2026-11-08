import type { Tool } from "./types.js";

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
      sdk: m.sdk ?? undefined,
      updated: m.lastModified ?? null,
      url: `https://huggingface.co/${prefix}${id}`,
    };
  });
  return { kind, query: input.query, count: results.length, results };
}

export const huggingfaceTool: Tool = {
  spec: {
    name: "search_huggingface",
    description:
      "Поиск на Hugging Face Hub: модели, датасеты или Spaces по ключевым словам. " +
      "Возвращает топ по числу скачиваний: id, скачивания, лайки, задача, ссылка.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Ключевые слова (англ. работает лучше)" },
        kind: {
          type: "string",
          enum: ["models", "datasets", "spaces"],
          description: "Что искать. По умолчанию models.",
        },
        task: {
          type: "string",
          description:
            "Только для models: pipeline-тег, напр. text-to-speech, " +
            "automatic-speech-recognition, text-generation, text-to-image.",
        },
        limit: { type: "integer", description: "Сколько вернуть (1-10). По умолчанию 5." },
      },
      required: ["query"],
    },
  },
  run: (input) => searchHuggingFace(input as HFInput),
};
