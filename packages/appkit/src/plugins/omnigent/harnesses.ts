interface HarnessInfo {
  label: string;
  /**
   * Unity Gateway API types it calls (a UC model service's
   * `supported_api_types`); a model must support one of them.
   */
  apis: string[];
  /** Default models, best first, when the workspace has them. */
  preferred: string[];
}

/**
 * Harnesses whose model calls a Databricks Sandbox routes through Unity
 * Gateway. The other harnesses Omnigent supports sign in with their vendor,
 * so they are not offered. Codex is left out for now: on a Sandbox host its
 * brokered sign-in rejects the Codex CLI version the Sandbox ships.
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

/** A Unity Gateway model, e.g. `system.ai.claude-sonnet-5`. */
export interface GatewayModel {
  name: string;
  /** The model service's `supported_api_types`. */
  apiTypes: string[];
}

/** A harness the user can pick, with the models it can drive. */
export interface HarnessOffer {
  id: string;
  label: string;
  models: string[];
  defaultModel?: string;
}

/**
 * What a user can pick: the allowed gateway harnesses, each with the models
 * whose API it speaks.
 */
export function offerHarnesses(opts: {
  allowed: string[];
  models: GatewayModel[];
}): HarnessOffer[] {
  const out: HarnessOffer[] = [];
  for (const id of opts.allowed) {
    const info = GATEWAY_HARNESSES[id];
    if (!info) continue;
    const models = opts.models
      .filter((m) => m.apiTypes.some((t) => info.apis.includes(t)))
      .map((m) => m.name);
    out.push({
      id,
      label: info.label,
      models,
      defaultModel: info.preferred.find((m) => models.includes(m)) ?? models[0],
    });
  }
  return out;
}
