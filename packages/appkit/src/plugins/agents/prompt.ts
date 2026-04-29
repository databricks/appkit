import {
  buildBaseSystemPrompt,
  composeSystemPrompt,
} from "../../core/agent/system-prompt";
import type {
  AgentsPluginConfig,
  BaseSystemPromptOption,
  PromptContext,
  RegisteredAgent,
} from "../../core/agent/types";

/**
 * Resolves the per-agent and plugin-level base prompt options into the
 * final system prompt sent to the adapter. Per-agent setting wins over
 * plugin-level; `false` opts out entirely; functions receive the same
 * `PromptContext` that the default builder uses.
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

  return composeSystemPrompt(base, registered.instructions);
}

/**
 * Resolves the plugin-level `autoInheritTools` config into a per-origin
 * decision. Default is opt-out for both origins. A markdown agent or
 * code-defined agent with no declared `tools:` gets an empty tool index
 * unless the developer explicitly flips `autoInheritTools` on. Even then,
 * only tools whose plugin author marked `autoInheritable: true` are
 * spread — see `applyAutoInherit` for the filter.
 */
export function normalizeAutoInherit(
  value: AgentsPluginConfig["autoInheritTools"],
): {
  file: boolean;
  code: boolean;
} {
  if (value === undefined) return { file: false, code: false };
  if (typeof value === "boolean") return { file: value, code: value };
  return { file: value.file ?? false, code: value.code ?? false };
}
