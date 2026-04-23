import type { PromptContext } from "./types";

/**
 * Default base system prompt: product identity, active AppKit plugins, and
 * tool-agnostic behavior hints.
 *
 * Individual tool definitions and JSON Schemas are still sent through the
 * model's `tools` / function-calling channel — this string is not a second
 * copy of that list. `ctx.toolNames` is available for custom
 * `baseSystemPrompt` callbacks; the default text stays short and does not
 * enumerate tools to avoid drift and token bloat.
 */
export function buildBaseSystemPrompt(ctx: PromptContext): string {
  const { pluginNames } = ctx;
  const lines: string[] = [
    "You are an AI assistant running on Databricks AppKit.",
  ];

  if (pluginNames.length > 0) {
    lines.push("");
    lines.push(`Active AppKit plugins: ${pluginNames.join(", ")}`);
  }

  lines.push("");
  lines.push("Guidelines:");
  lines.push(
    "- Be concise: for large or noisy tool output, summarize what matters and how to go deeper instead of pasting everything.",
  );
  lines.push(
    "- Use each tool as defined: pass required arguments and use the syntax, dialect, or path rules the target system expects (see each tool’s description and schema).",
  );
  lines.push(
    "- If a tool call fails, explain the error in plain language and suggest a fix or next step.",
  );
  lines.push(
    "- Respect tool metadata and app policy: read-only vs destructive tools, user/identity context, and any approval or safety flows the app provides.",
  );

  return lines.join("\n");
}

/**
 * Compose the full system prompt from the base prompt and an optional
 * per-agent user prompt.
 */
export function composeSystemPrompt(
  basePrompt: string,
  agentPrompt?: string,
): string {
  if (!agentPrompt) return basePrompt;
  return `${basePrompt}\n\n${agentPrompt}`;
}
