import type { OmnigentHarness } from "./types";

interface HarnessInfo {
  label: string;
  /**
   * Unity AI Gateway API types it calls (a UC model service's
   * `supported_api_types`); a model must support one of them.
   */
  apis: string[];
  /** Default models, best first, when the workspace has them. */
  preferred: string[];
}

/**
 * Harnesses whose model calls Omnigent routes through a Databricks profile
 * (`AuthModel.OMNIGENT_CREDENTIAL`), so they go through Unity AI Gateway.
 * The other harnesses Omnigent supports sign in with their vendor, so they
 * are not offered.
 */
const GATEWAY_HARNESSES: Readonly<Record<string, HarnessInfo>> = {
  "claude-sdk": {
    label: "Claude Agent SDK",
    apis: ["anthropic/v1/messages"],
    preferred: ["system.ai.claude-sonnet-5", "system.ai.claude-opus-5-5"],
  },
  pi: {
    label: "Pi",
    // Pi reaches Databricks models through the Codex responses API; on the
    // chat-completions path Gemini fails with an empty 400 (tested).
    apis: ["codex/v1/responses"],
    preferred: ["system.ai.gpt-5-5"],
  },
  "openai-agents": {
    label: "OpenAI Agents SDK",
    apis: ["openai/v1/responses"],
    preferred: ["system.ai.gpt-5-5"],
  },
};

export const DEFAULT_HARNESSES = Object.keys(GATEWAY_HARNESSES);

/** A Unity AI Gateway model, e.g. `system.ai.claude-sonnet-5`. */
export interface GatewayModel {
  name: string;
  /** The model service's `supported_api_types`. */
  apiTypes: string[];
}

export interface HarnessOffer extends OmnigentHarness {
  models: string[];
  defaultModel?: string;
}

/**
 * What a user can pick: the allowed gateway harnesses their host reports as
 * usable, each with the models whose API it speaks.
 */
export function offerHarnesses(opts: {
  allowed: string[];
  configured: Record<string, boolean | string>;
  models: GatewayModel[];
}): HarnessOffer[] {
  const out: HarnessOffer[] = [];
  for (const id of opts.allowed) {
    const info = GATEWAY_HARNESSES[id];
    const ready = opts.configured[id];
    if (!info) continue;
    // "needs-auth" is advisory for gateway harnesses: their auth comes from the profile.
    if (ready === undefined || ready === false || ready === "binary-missing")
      continue;
    const models = opts.models
      .filter((m) => m.apiTypes.some((t) => info.apis.includes(t)))
      .map((m) => m.name);
    out.push({
      id,
      label: info.label,
      ready,
      models,
      defaultModel: info.preferred.find((m) => models.includes(m)) ?? models[0],
    });
  }
  return out;
}
