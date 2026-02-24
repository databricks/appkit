import type { LLMTool } from "./llm-client";

export function buildGenieSpaceTools(
  genieSpaces: Record<string, string>,
  descriptions?: Record<string, string>,
): LLMTool[] {
  return Object.entries(genieSpaces).map(([alias, spaceId]) => ({
    type: "function" as const,
    function: {
      name: `query_${alias}`,
      description:
        descriptions?.[alias] ??
        `Query the "${alias}" Genie space (ID: ${spaceId}).`,
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: `The question to send to the "${alias}" Genie space.`,
          },
        },
        required: ["question"],
      },
    },
  }));
}

/** Extracts alias from tool name: "query_sales" → "sales" */
export function aliasFromToolName(name: string): string | null {
  return name.startsWith("query_") ? name.slice("query_".length) : null;
}
