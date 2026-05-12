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
  /**
   * Registered plugin toolkits referenced by `plugin:NAME` entries in the
   * unified `tools:` frontmatter list. Keyed by plugin name; each value
   * exposes the same `toolkit(opts?)` surface as the `plugins` argument to
   * `tools(plugins) => Record<...>` in the code form.
   */
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
  /**
   * Unified tool list. Each entry is one of:
   *
   * - **`plugin:<name>`** (string) — pull every tool from the named plugin.
   * - **`plugin:<name>: [tool1, tool2]`** — pull only the listed tools
   *   (shorthand for `{ only: [...] }`).
   * - **`plugin:<name>: { ...ToolkitOptions }`** — pass full
   *   `prefix` / `only` / `except` / `rename` options.
   * - **`<key>`** (string, no `plugin:` prefix) — ambient tool name
   *   resolved against the `agents({ tools: { ... } })` config.
   *
   * Mirrors the TS function form `tools(plugins) { ... }` where plugin
   * tools and inline tools live in the same record.
   */
  tools?: FrontmatterToolEntry[];
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

/**
 * Each item in {@link Frontmatter.tools}. Strings are either ambient tool
 * names (no prefix) or bare plugin references (`plugin:NAME`). Objects are
 * single-key mappings whose key is `plugin:NAME` and whose value is either
 * an array of local tool names (sugar for `{ only: [...] }`) or a full
 * `ToolkitOptions` record.
 *
 * Named `FrontmatterToolEntry` to avoid colliding with the exported
 * `ToolEntry` from `tools/define-tool.ts` — that is the plugin-author API
 * surface (`defineTool({ ... }) : ToolEntry`); this is the frontmatter
 * parse type. They are unrelated and live in different layers.
 */
type FrontmatterToolEntry =
  | string
  | { [key: string]: ToolkitOptions | string[] };

const PLUGIN_PREFIX = "plugin:";

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

  for (const entry of fm.tools ?? []) {
    const parsed = parseToolEntry(entry, filePath, agentName);
    if (parsed.kind === "plugin") {
      const provider = pluginIdx.get(parsed.pluginName);
      if (!provider) {
        const available =
          pluginIdx.size > 0
            ? Array.from(pluginIdx.keys()).join(", ")
            : "<none>";
        throw new Error(
          `Agent '${agentName}' (${filePath}) references 'plugin:${parsed.pluginName}', but plugin '${parsed.pluginName}' is not registered. Available: ${available}`,
        );
      }
      const entries = provider.toolkit(parsed.opts) as Record<string, unknown>;
      for (const [key, value] of Object.entries(entries)) {
        if (!isToolkitEntry(value)) {
          throw new Error(
            `Plugin '${parsed.pluginName}'.toolkit() returned a value at key '${key}' that is not a ToolkitEntry`,
          );
        }
        out[key] = value as ToolkitEntry;
      }
    } else {
      const tool = ctx.availableTools?.[parsed.toolName];
      if (!tool) {
        const available = ctx.availableTools
          ? Object.keys(ctx.availableTools).join(", ")
          : "<none>";
        throw new Error(
          `Agent '${agentName}' (${filePath}) references ambient tool '${parsed.toolName}', which is not in the agents() plugin's tools field. Available: ${available}. ` +
            "If you meant to reference a plugin, use the 'plugin:NAME' prefix.",
        );
      }
      out[parsed.toolName] = tool;
    }
  }

  return out;
}

type ParsedToolEntry =
  | { kind: "plugin"; pluginName: string; opts: ToolkitOptions | undefined }
  | { kind: "ambient"; toolName: string };

/**
 * Classify one item in the `tools:` frontmatter list into either a plugin
 * reference (with optional ToolkitOptions) or an ambient tool lookup.
 *
 * Strings starting with `plugin:` are bare plugin references. Strings
 * without the prefix are ambient tool names. Object entries are
 * single-key mappings keyed by `plugin:NAME`; the value is either an
 * array (sugar for `{ only: [...] }`) or a full `ToolkitOptions` record.
 */
function parseToolEntry(
  entry: FrontmatterToolEntry,
  filePath: string,
  agentName: string,
): ParsedToolEntry {
  if (typeof entry === "string") {
    if (entry.startsWith(PLUGIN_PREFIX)) {
      const pluginName = entry.slice(PLUGIN_PREFIX.length);
      if (pluginName.length === 0) {
        throw new Error(
          `Agent '${agentName}' (${filePath}) has an empty plugin name in 'plugin:'.`,
        );
      }
      return { kind: "plugin", pluginName, opts: undefined };
    }
    if (entry.length === 0) {
      throw new Error(
        `Agent '${agentName}' (${filePath}) has an empty string in 'tools:'.`,
      );
    }
    return { kind: "ambient", toolName: entry };
  }
  if (typeof entry !== "object" || entry === null) {
    throw new Error(
      `Agent '${agentName}' (${filePath}) has invalid 'tools:' entry: ${JSON.stringify(entry)}`,
    );
  }
  const keys = Object.keys(entry);
  if (keys.length !== 1) {
    throw new Error(
      `Agent '${agentName}' (${filePath}) 'tools:' object entry must have exactly one key, got: ${keys.join(", ")}`,
    );
  }
  const key = keys[0];
  // Bare `- plugin:` (no name after the colon) parses as a mapping with the
  // key `"plugin"`. Catch that as a friendly error rather than dumping it
  // through the generic "expected key 'plugin:NAME'" branch.
  if (key === "plugin") {
    throw new Error(
      `Agent '${agentName}' (${filePath}) has an empty plugin name in 'plugin:'.`,
    );
  }
  if (!key.startsWith(PLUGIN_PREFIX)) {
    throw new Error(
      `Agent '${agentName}' (${filePath}) 'tools:' object entries are reserved for plugin references; expected key 'plugin:NAME', got '${key}'. ` +
        "Use a bare string for ambient tools (e.g. `- get_weather`).",
    );
  }
  const pluginName = key.slice(PLUGIN_PREFIX.length);
  if (pluginName.length === 0) {
    throw new Error(
      `Agent '${agentName}' (${filePath}) has an empty plugin name in 'plugin:'.`,
    );
  }
  const value = entry[key];
  if (Array.isArray(value)) {
    return { kind: "plugin", pluginName, opts: { only: value } };
  }
  if (typeof value === "object" && value !== null) {
    return {
      kind: "plugin",
      pluginName,
      opts: value as ToolkitOptions,
    };
  }
  throw new Error(
    `Agent '${agentName}' (${filePath}) 'plugin:${pluginName}' options must be an array of tool names or a ToolkitOptions object.`,
  );
}
