import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../../logging/logger";

const logger = createLogger("agent:config");

export interface AgentFileConfig {
  name: string;
  endpoint?: string;
  maxSteps?: number;
  maxTokens?: number;
  default?: boolean;
  systemPrompt: string;
}

/**
 * Parse a frontmatter markdown string into data + content.
 * Handles flat YAML key-value pairs (string, number, boolean).
 */
export function parseFrontmatter(raw: string): {
  data: Record<string, unknown>;
  content: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { data: {}, content: raw.trim() };

  const data: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();
    if (!key) continue;

    if (rawVal === "true") data[key] = true;
    else if (rawVal === "false") data[key] = false;
    else if (/^\d+$/.test(rawVal)) data[key] = Number(rawVal);
    else if (/^\d+\.\d+$/.test(rawVal)) data[key] = Number(rawVal);
    else data[key] = rawVal;
  }

  return { data, content: match[2].trim() };
}

/**
 * Load agent configs from a directory of frontmatter markdown files.
 * Returns an empty array if the directory doesn't exist.
 */
export function loadAgentConfigs(agentsDir: string): AgentFileConfig[] {
  if (!fs.existsSync(agentsDir)) return [];

  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  const configs: AgentFileConfig[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(agentsDir, file), "utf-8");
      const { data, content } = parseFrontmatter(raw);
      const name = path.basename(file, ".md");

      const config: AgentFileConfig = {
        name,
        systemPrompt: content,
      };

      if (typeof data.endpoint === "string") config.endpoint = data.endpoint;
      if (typeof data.maxSteps === "number") config.maxSteps = data.maxSteps;
      if (typeof data.maxTokens === "number") config.maxTokens = data.maxTokens;
      if (typeof data.default === "boolean") config.default = data.default;

      if (data.maxSteps !== undefined && typeof data.maxSteps !== "number") {
        logger.warn(
          "Agent '%s': maxSteps should be a number, got %s. Using default.",
          name,
          typeof data.maxSteps,
        );
      }

      if (data.maxTokens !== undefined && typeof data.maxTokens !== "number") {
        logger.warn(
          "Agent '%s': maxTokens should be a number, got %s. Using default.",
          name,
          typeof data.maxTokens,
        );
      }

      configs.push(config);
    } catch (error) {
      logger.error("Failed to load agent config '%s': %O", file, error);
    }
  }

  return configs;
}
