import { renderSkillCatalog } from "../../core/agent/skills";
import {
  buildBaseSystemPrompt,
  composeSystemPrompt,
} from "../../core/agent/system-prompt";
import type {
  BaseSystemPromptOption,
  PromptContext,
  RegisteredAgent,
} from "../../core/agent/types";

/**
 * Composes an agent's full system prompt: resolves the base prompt (per-agent
 * override, else plugin-level, else the built-in default), combines it with the
 * agent's instructions, then appends the always-on skill catalog.
 */
export function composePromptForAgent(
  registered: RegisteredAgent,
  pluginLevel: BaseSystemPromptOption | undefined,
  ctx: PromptContext,
): string {
  const perAgent = registered.baseSystemPrompt;
  const resolved = perAgent !== undefined ? perAgent : pluginLevel;

  let base = "";
  if (resolved === false) {
    base = "";
  } else if (typeof resolved === "string") {
    base = resolved;
  } else if (typeof resolved === "function") {
    base = resolved(ctx);
  } else {
    base = buildBaseSystemPrompt(ctx);
  }

  const composed = composeSystemPrompt(base, registered.instructions);

  // Append the always-on skill catalog (name + description only). Done here,
  // after composeSystemPrompt, so it survives a custom/`false` base prompt.
  const catalog = registered.skills?.catalog;
  if (!catalog || catalog.length === 0) return composed;
  return `${composed}\n\n${renderSkillCatalog(catalog)}`;
}
