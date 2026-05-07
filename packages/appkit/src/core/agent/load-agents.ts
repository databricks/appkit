import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type { AgentAdapter } from "shared";
import type {
  AgentDefinition,
  AgentTool,
  BaseSystemPromptOption,
  ToolkitEntry,
  ToolkitOptions,
} from "../../core/agent/types";
import { isToolkitEntry } from "../../core/agent/types";
import { createLogger } from "../../logging/logger";

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
  /**
   * Code-defined agents contributed by `agents({ agents: { ... } })`. The
   * directory loader resolves `agents:` frontmatter references against
   * these alongside sibling markdown files, so a markdown parent can
   * delegate to a code-defined child. Code-defined names win on collision
   * with markdown names, matching the plugin's top-level merge precedence.
   */
  codeAgents?: Record<string, AgentDefinition>;
}

export interface LoadResult {
  /** Agent definitions keyed by agent id (directory name under `dir`). */
  defs: Record<string, AgentDefinition>;
  /** First agent with `default: true` frontmatter (sorted id order), or `null`. */
  defaultAgent: string | null;
}

interface Frontmatter {
  endpoint?: string;
  model?: string;
  toolkits?: ToolkitSpec[];
  tools?: string[];
  /**
   * Other agent ids to expose as sub-agents. Each becomes an `agent-<id>`
   * tool at runtime. Resolution happens at directory-load time in
   * {@link loadAgentsFromDir}; the single-file {@link loadAgentFromFile} path
   * rejects non-empty values since there are no siblings to resolve against.
   */
  agents?: string[];
  maxSteps?: number;
  maxTokens?: number;
  default?: boolean;
  baseSystemPrompt?: false | string;
  ephemeral?: boolean;
}

type ToolkitSpec = string | { [pluginName: string]: ToolkitOptions | string[] };

/**
 * Derives the logical agent id from a markdown path. When the file is named
 * `agent.md`, the id is the parent directory name (folder-based layout);
 * otherwise the id is the file stem (e.g. legacy single-file paths).
 */
export function agentIdFromMarkdownPath(filePath: string): string {
  const normalized = path.normalize(filePath);
  const base = path.basename(normalized);
  const parent = path.basename(path.dirname(normalized));
  if (base === "agent.md" && parent && parent !== "." && parent !== "..") {
    return parent;
  }
  return path.basename(normalized, ".md");
}

const ALLOWED_KEYS = new Set([
  "endpoint",
  "model",
  "toolkits",
  "tools",
  "agents",
  "maxSteps",
  "maxTokens",
  "default",
  "baseSystemPrompt",
  "ephemeral",
]);

/**
 * Loads a single markdown agent file and resolves its frontmatter against
 * registered plugin toolkits + ambient tool library.
 *
 * Rejects non-empty `agents:` frontmatter because single-file loads have
 * no siblings to resolve sub-agent references against — callers must use
 * {@link loadAgentsFromDir} when markdown agents delegate to one another.
 */
export async function loadAgentFromFile(
  filePath: string,
  ctx: LoadContext,
): Promise<AgentDefinition> {
  const raw = await fs.readFile(filePath, "utf-8");
  const name = agentIdFromMarkdownPath(filePath);
  const { data } = parseFrontmatter(raw, filePath);
  if (Array.isArray(data?.agents) && data.agents.length > 0) {
    throw new Error(
      `Agent '${name}' (${filePath}) declares 'agents:' in frontmatter, ` +
        `which requires loadAgentsFromDir to resolve sibling references. ` +
        `Use loadAgentsFromDir, or wire sub-agents in code via createAgent({ agents: { ... } }).`,
    );
  }
  return buildDefinition(name, raw, filePath, ctx);
}

/**
 * Scans a directory for one subdirectory per agent, each containing
 * `agent.md` (frontmatter + body). Produces an `AgentDefinition` record keyed
 * by agent id (folder name). Throws on frontmatter errors or unresolved
 * references. Returns an empty map if the directory does not exist.
 *
 * Legacy top-level `*.md` files are rejected with an error — migrate each to
 * `<id>/agent.md` under a sibling folder named for the agent id.
 *
 * Runs in two passes so sub-agent references in frontmatter (`agents: [...]`)
 * can be resolved regardless of directory iteration order:
 *
 * 1. Build every agent's definition from its own `agent.md`.
 * 2. Walk `agents:` references and wire `def.agents = { child: childDef }`
 *    by looking them up in the complete map. Dangling names and
 *    self-references fail loudly; mutual delegation is allowed and bounded
 *    at runtime by `limits.maxSubAgentDepth`.
 */
export async function loadAgentsFromDir(
  dir: string,
  ctx: LoadContext,
): Promise<LoadResult> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { defs: {}, defaultAgent: null };
    }
    throw err;
  }
  const orphanMd = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();

  if (orphanMd.length > 0) {
    const hint = orphanMd
      .map((f) => `${path.basename(f, ".md")}/agent.md`)
      .join(", ");
    throw new Error(
      `Agents directory contains unsupported top-level markdown file(s): ${orphanMd.join(", ")}. ` +
        `Use one folder per agent with a fixed entry file, e.g. ${hint}.`,
    );
  }

  /** Reserved folder name until per-agent skills land; not an agent package. */
  const RESERVED_DIRS = new Set(["skills"]);

  const agentIds = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !RESERVED_DIRS.has(name))
    .sort();

  const defs: Record<string, AgentDefinition> = {};
  const subAgentRefs: Record<string, string[]> = {};
  let defaultAgent: string | null = null;

  // Pass 1: build every agent's definition; collect sub-agent refs.
  for (const id of agentIds) {
    const agentPath = path.join(dir, id, "agent.md");
    let raw: string;
    try {
      raw = await fs.readFile(agentPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Agents subdirectory '${path.join(dir, id)}' must contain agent.md.`,
        );
      }
      throw err;
    }
    defs[id] = buildDefinition(id, raw, agentPath, ctx);
    const { data } = parseFrontmatter(raw, agentPath);
    if (data?.agents !== undefined) {
      subAgentRefs[id] = normalizeAgentsFrontmatter(data.agents, id, agentPath);
    }
    if (data?.default === true && !defaultAgent) {
      defaultAgent = id;
    }
  }

  // Pass 2: resolve sub-agent references against the complete defs map.
  // Code-defined agents (ctx.codeAgents) take precedence over markdown ones
  // with the same name, matching the plugin's top-level merge behaviour.
  for (const [name, refs] of Object.entries(subAgentRefs)) {
    if (refs.length === 0) continue;
    const children: Record<string, AgentDefinition> = {};
    const missing: string[] = [];
    for (const ref of refs) {
      if (ref === name) {
        throw new Error(
          `Agent '${name}' (${path.join(dir, name, "agent.md")}) cannot reference itself in 'agents:'.`,
        );
      }
      const sibling = ctx.codeAgents?.[ref] ?? defs[ref];
      if (!sibling) {
        missing.push(ref);
        continue;
      }
      children[ref] = sibling;
    }
    if (missing.length > 0) {
      const available =
        [...Object.keys(ctx.codeAgents ?? {}), ...Object.keys(defs)]
          .sort()
          .join(", ") || "<none>";
      throw new Error(
        `Agent '${name}' references sub-agent(s) '${missing.join(", ")}' in 'agents:', ` +
          `but no markdown or code agent(s) with those names exist. ` +
          `Available: ${available}.`,
      );
    }
    defs[name].agents = children;
  }

  return { defs, defaultAgent };
}

/**
 * Validates that `agents:` frontmatter is an array of non-empty strings and
 * returns it with duplicates removed. Throws with a clear per-file message
 * on malformed input rather than silently ignoring.
 */
function normalizeAgentsFrontmatter(
  value: unknown,
  agentName: string,
  filePath: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `Agent '${agentName}' (${filePath}) has invalid 'agents:' frontmatter: ` +
        `expected an array of sibling agent ids, got ${typeof value}.`,
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(
        `Agent '${agentName}' (${filePath}) has invalid 'agents:' entry: ` +
          `expected non-empty string, got ${JSON.stringify(item)}.`,
      );
    }
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
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
    ephemeral: typeof fm.ephemeral === "boolean" ? fm.ephemeral : undefined,
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
