import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { AgentAdapter } from "shared";
import { createLogger } from "../../logging/logger";
import type {
  AgentDefinition,
  AgentTool,
  BaseSystemPromptOption,
  ToolkitEntry,
  ToolkitOptions,
} from "./types";
import { isToolkitEntry } from "./types";

const logger = createLogger("agents:loader");

interface ToolkitProvider {
  toolkit: (opts?: ToolkitOptions) => Record<string, unknown>;
}

export interface LoadContext {
  /** Default model when frontmatter has no `endpoint` and the def has no `model`. */
  defaultModel?: AgentAdapter | Promise<AgentAdapter> | string;
  /** Ambient tool library referenced by frontmatter `tools: [key1, key2]`. */
  availableTools?: Record<string, AgentTool>;
  /** Registered plugin toolkits referenced by frontmatter `toolkits: [...]`. */
  plugins?: Map<string, ToolkitProvider>;
}

export interface LoadResult {
  /** Agent definitions keyed by file-stem name. */
  defs: Record<string, AgentDefinition>;
  /** First file with `default: true` frontmatter, or `null`. */
  defaultAgent: string | null;
}

interface Frontmatter {
  endpoint?: string;
  model?: string;
  toolkits?: ToolkitSpec[];
  tools?: string[];
  maxSteps?: number;
  maxTokens?: number;
  default?: boolean;
  baseSystemPrompt?: false | string;
}

type ToolkitSpec = string | { [pluginName: string]: ToolkitOptions | string[] };

const ALLOWED_KEYS = new Set([
  "endpoint",
  "model",
  "toolkits",
  "tools",
  "maxSteps",
  "maxTokens",
  "default",
  "baseSystemPrompt",
]);

/**
 * Loads a single markdown agent file and resolves its frontmatter against
 * registered plugin toolkits + ambient tool library.
 */
export async function loadAgentFromFile(
  filePath: string,
  ctx: LoadContext,
): Promise<AgentDefinition> {
  const raw = fs.readFileSync(filePath, "utf-8");
  const name = path.basename(filePath, ".md");
  return buildDefinition(name, raw, filePath, ctx);
}

/**
 * Scans a directory for `*.md` files and produces an `AgentDefinition` record
 * keyed by file-stem. Throws on frontmatter errors or unresolved references.
 * Returns an empty map if the directory does not exist.
 */
export async function loadAgentsFromDir(
  dir: string,
  ctx: LoadContext,
): Promise<LoadResult> {
  if (!fs.existsSync(dir)) {
    return { defs: {}, defaultAgent: null };
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  const defs: Record<string, AgentDefinition> = {};
  let defaultAgent: string | null = null;

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const raw = fs.readFileSync(fullPath, "utf-8");
    const name = path.basename(file, ".md");
    defs[name] = buildDefinition(name, raw, fullPath, ctx);
    const { data } = parseFrontmatter(raw, fullPath);
    if (data?.default === true && !defaultAgent) {
      defaultAgent = name;
    }
  }

  if (!defaultAgent && Object.keys(defs).length > 0) {
    // Fall through — plugin's defaultAgent resolution handles "first registered".
  }

  return { defs, defaultAgent };
}

/** Exposed for tests. Parses `--- yaml ---\nbody` and validates frontmatter keys. */
export function parseFrontmatter(
  raw: string,
  sourcePath?: string,
): { data: Frontmatter | null; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { data: null, content: raw.trim() };
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(match[1]);
  } catch (err) {
    const src = sourcePath ? ` (${sourcePath})` : "";
    throw new Error(
      `Invalid YAML frontmatter${src}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || parsed === undefined) {
    return { data: {}, content: match[2].trim() };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    const src = sourcePath ? ` (${sourcePath})` : "";
    throw new Error(`Frontmatter must be a YAML object${src}`);
  }
  const data = parsed as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (!ALLOWED_KEYS.has(key)) {
      logger.warn(
        "Ignoring unknown frontmatter key '%s' in %s",
        key,
        sourcePath ?? "<inline>",
      );
    }
  }
  return { data: data as Frontmatter, content: match[2].trim() };
}

function buildDefinition(
  name: string,
  raw: string,
  filePath: string,
  ctx: LoadContext,
): AgentDefinition {
  const { data, content } = parseFrontmatter(raw, filePath);
  const fm: Frontmatter = data ?? {};

  const tools = resolveFrontmatterTools(name, fm, filePath, ctx);
  const model = fm.model ?? fm.endpoint ?? ctx.defaultModel;

  let baseSystemPrompt: BaseSystemPromptOption | undefined;
  if (fm.baseSystemPrompt === false) baseSystemPrompt = false;
  else if (typeof fm.baseSystemPrompt === "string")
    baseSystemPrompt = fm.baseSystemPrompt;

  return {
    name,
    instructions: content,
    model,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    maxSteps: typeof fm.maxSteps === "number" ? fm.maxSteps : undefined,
    maxTokens: typeof fm.maxTokens === "number" ? fm.maxTokens : undefined,
    baseSystemPrompt,
  };
}

function resolveFrontmatterTools(
  agentName: string,
  fm: Frontmatter,
  filePath: string,
  ctx: LoadContext,
): Record<string, AgentTool> {
  const out: Record<string, AgentTool> = {};
  const pluginIdx = ctx.plugins ?? new Map<string, ToolkitProvider>();

  for (const spec of fm.toolkits ?? []) {
    const [pluginName, opts] = parseToolkitSpec(spec, filePath, agentName);
    const provider = pluginIdx.get(pluginName);
    if (!provider) {
      throw new Error(
        `Agent '${agentName}' (${filePath}) references toolkit '${pluginName}', but plugin '${pluginName}' is not registered. Available: ${
          pluginIdx.size > 0
            ? Array.from(pluginIdx.keys()).join(", ")
            : "<none>"
        }`,
      );
    }
    const entries = provider.toolkit(opts) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(entries)) {
      if (!isToolkitEntry(entry)) {
        throw new Error(
          `Plugin '${pluginName}'.toolkit() returned a value at key '${key}' that is not a ToolkitEntry`,
        );
      }
      out[key] = entry as ToolkitEntry;
    }
  }

  for (const key of fm.tools ?? []) {
    const tool = ctx.availableTools?.[key];
    if (!tool) {
      const available = ctx.availableTools
        ? Object.keys(ctx.availableTools).join(", ")
        : "<none>";
      throw new Error(
        `Agent '${agentName}' (${filePath}) references tool '${key}', which is not in the agents() plugin's tools field. Available: ${available}`,
      );
    }
    out[key] = tool;
  }

  return out;
}

function parseToolkitSpec(
  spec: ToolkitSpec,
  filePath: string,
  agentName: string,
): [string, ToolkitOptions | undefined] {
  if (typeof spec === "string") {
    return [spec, undefined];
  }
  if (typeof spec !== "object" || spec === null) {
    throw new Error(
      `Agent '${agentName}' (${filePath}) has invalid toolkit entry: ${JSON.stringify(spec)}`,
    );
  }
  const keys = Object.keys(spec);
  if (keys.length !== 1) {
    throw new Error(
      `Agent '${agentName}' (${filePath}) toolkit entry must have exactly one key, got: ${keys.join(", ")}`,
    );
  }
  const pluginName = keys[0];
  const value = spec[pluginName];
  if (Array.isArray(value)) {
    return [pluginName, { only: value }];
  }
  if (typeof value === "object" && value !== null) {
    return [pluginName, value as ToolkitOptions];
  }
  throw new Error(
    `Agent '${agentName}' (${filePath}) toolkit '${pluginName}' options must be an array of tool names or an options object`,
  );
}
