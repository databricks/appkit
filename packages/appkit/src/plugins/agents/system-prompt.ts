/**
 * Builds the AppKit base system prompt from active plugin names.
 *
 * The base prompt provides guidelines and app context. It does NOT
 * include individual tool descriptions — those are sent via the
 * structured `tools` API parameter to the LLM.
 */
export function buildBaseSystemPrompt(pluginNames: string[]): string {
  const lines: string[] = [
    "You are an AI assistant running on Databricks AppKit.",
  ];

  if (pluginNames.length > 0) {
    lines.push("");
    lines.push(`Active plugins: ${pluginNames.join(", ")}`);
  }

  lines.push("");
  lines.push("Guidelines:");
  lines.push("- Use Databricks SQL syntax when writing queries");
  lines.push(
    "- When results are large, summarize key findings rather than dumping raw data",
  );
  lines.push("- If a tool call fails, explain the error clearly to the user");
  lines.push("- When browsing files, verify the path exists before reading");

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
