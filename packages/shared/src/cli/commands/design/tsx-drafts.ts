// TSX design drafts: one shared client/src/design/mock.ts plus N pages at
// client/src/design/pages/<name>.tsx (served by the design plugin at
// /design/<name>). Ported from the KIT-37 playground (apps/tsx-drafts).
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { WorkspaceClient } from "../../../workspace-client";

const MAX_FIX_ROUNDS = 2;
const CONTRACT_END = "// @end-contract";

const VARIANTS = [
  "Direction A: the most conventional, information-dense layout for this kind of app.",
  "Direction B: a bolder, more spacious layout with strong visual hierarchy and one hero element.",
  "Direction C: a compact, tool-like layout optimized for repeated daily use (sidebar or split panes welcome).",
];

/**
 * A draft's state in `<design>/.staging/status.json`. The design plugin turns
 * `compiled` into `rendering` / `ready` / `failed` from what the browser
 * reports for the page.
 */
type WriterState = "writing" | "type-checking" | "compiled" | "failed";

interface DraftStatus {
  name: string;
  /** Page URL once compiled, `/design/<name>`; null for mock.ts. */
  path: string | null;
  state: WriterState;
  fixRounds: number;
  error?: string;
}

interface TsxStatusFile {
  prompt: string;
  answers: string;
  done: boolean;
  mock: DraftStatus;
  drafts: DraftStatus[];
}

const promptDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "prompt",
);

/**
 * The system prompt shared by every writer call (the cached prefix):
 * rules, components.schema.json, the appkit-ui exports drafts use, and one
 * example page with its mock.
 */
export async function systemPrompt(): Promise<string> {
  const [schema, examplePage, exampleMock] = await Promise.all(
    [
      "components.schema.json",
      "example-page.tsx.txt",
      "example-mock.ts.txt",
    ].map((f) => fs.readFile(path.join(promptDir, f), "utf8")),
  );
  return `You write design drafts for Databricks Apps as a single React + TypeScript file.

Output ONLY the file contents. No markdown fences, no commentary before or after.

Rules:
- Components come from "@databricks/appkit-ui/react" (see the schema below), icons from "lucide-react", hooks from "react". No other imports except "../mock".
- Style with Tailwind classes using theme tokens only: bg-background, bg-card, bg-muted, bg-primary, bg-secondary, bg-accent, text-foreground, text-muted-foreground, text-primary, text-primary-foreground, text-destructive, text-success, text-warning, border, border-border, ring, bg-chart-1..5, text-chart-1..5 and their /opacity variants. NEVER use color literals (no hex, rgb, oklch, or palette classes like bg-blue-500, text-gray-700, bg-white, text-black). The page must work in light and dark mode unchanged.
- Charts receive mock data via the \`data\` prop; never pass queryKey. A chart x field whose name contains "date"/"time" (or whose values look like dates) becomes a time axis, so keep those values as ISO strings (e.g. "2024-06-03"); for display labels like "Jun 3" use a field named "label" or "day".
- Self-contained: all state is local React state. No fetch, no routing library. Multi-page apps switch views with Tabs or local state.
- TypeScript strict mode: no implicit any, no unused imports or variables.
- Default-export one component. The page fills the viewport width; wrap content in a centered max-w container with padding.

Component schema (components.schema.json):
${schema}

appkit-ui exports most used in drafts:
- Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter
- Button {variant, size, asChild}, Badge {variant}, Alert/AlertTitle/AlertDescription {variant}
- Tabs/TabsList/TabsTrigger/TabsContent {value}, Table/TableHeader/TableBody/TableRow/TableHead/TableCell
- Input, Textarea, Label, Select/SelectTrigger/SelectValue/SelectContent/SelectItem, Checkbox, Switch, RadioGroup/RadioGroupItem, Slider, Progress {value}
- Field/FieldLabel/FieldDescription/FieldError/FieldGroup/FieldSet/FieldLegend, Separator, Skeleton, Kbd
- BarChart, LineChart, AreaChart, DonutChart, PieChart, ScatterChart, HeatmapChart {data, xKey, yKey, height, title, stacked, orientation}

Example mock module (../mock):
${exampleMock}

Example design page:
${examplePage}`;
}

type Message = { role: "user" | "assistant"; content: string };

const stripFences = (s: string) =>
  `${s
    .replace(/^\s*```\w*\n/, "")
    .replace(/\n```\s*$/, "")
    .trim()}\n`;

interface TsxDraftOptions {
  client: WorkspaceClient;
  prompt: string;
  answers?: string;
  /** Draft names are `<name>-a`, `<name>-b`, ... */
  name?: string;
  /** App folder (holds client/ and the client tsconfig). */
  appRoot?: string;
  /** tsconfig the drafts are checked against, relative to appRoot. */
  tsconfig?: string;
  model?: string;
  effort?: "low" | "medium" | "high";
  onStatus?: (status: TsxStatusFile) => void;
}

/**
 * Writes mock.ts and one page per direction in parallel, each a streaming
 * AI Gateway call (`/ai-gateway/anthropic/v1/messages`) sharing one cached
 * system prompt. Each file is type-checked with the app's tsc and sent back
 * with the errors for up to 2 fix rounds. A page is moved into pages/ only
 * once it compiles; the mock into design/mock.ts before any page.
 */
export async function writeTsxDrafts(
  opts: TsxDraftOptions,
): Promise<TsxStatusFile> {
  const appRoot = path.resolve(opts.appRoot ?? process.cwd());
  const designDir = path.join(appRoot, "client/src/design");
  const stagingDir = path.join(designDir, ".staging");
  const pagesDir = path.join(designDir, "pages");
  const statusFile = path.join(stagingDir, "status.json");
  const tsconfig = path.join(
    appRoot,
    opts.tsconfig ??
      ((await exists(path.join(appRoot, "tsconfig.client.json")))
        ? "tsconfig.client.json"
        : "client/tsconfig.json"),
  );
  // typescript's exports don't list bin/tsc; find it next to its package.json.
  const tsc = path.join(
    path.dirname(
      createRequire(path.join(appRoot, "package.json")).resolve(
        "typescript/package.json",
      ),
    ),
    "bin/tsc",
  );
  const model = opts.model ?? "system.ai.claude-sonnet-5-5";
  // Sonnet 5.5 thinks by default (and rejects thinking: disabled); low effort skips it.
  const effort = opts.effort ?? "low";
  const base = opts.name ?? "draft";
  const system = await systemPrompt();

  // mock.ts is shared by one run's drafts, so a new run replaces the
  // previous run's pages (and only those: other design pages stay).
  const previous = await readStatus(statusFile);
  for (const d of previous?.drafts ?? []) {
    await fs.rm(path.join(pagesDir, `${d.name}.tsx`), { force: true });
  }
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });
  await fs.mkdir(pagesDir, { recursive: true });

  const status: TsxStatusFile = {
    prompt: opts.prompt,
    answers: opts.answers ?? "",
    done: false,
    mock: { name: "mock", path: null, state: "writing", fixRounds: 0 },
    drafts: VARIANTS.map((_, i) => ({
      name: `${base}-${"abcdefgh"[i]}`,
      path: null,
      state: "writing",
      fixRounds: 0,
    })),
  };
  // Renamed into place so a reader never sees a half-written file.
  let saving = Promise.resolve();
  const save = () => {
    saving = saving.then(async () => {
      await fs.writeFile(`${statusFile}.tmp`, JSON.stringify(status, null, 2));
      await fs.rename(`${statusFile}.tmp`, statusFile);
      opts.onStatus?.(status);
    });
    return saving;
  };
  await save();

  async function stream(
    messages: Message[],
    onText?: (soFar: string) => void,
  ): Promise<string> {
    // Throws ApiError on a non-2xx status; the body is left unread so it can stream.
    const res = await opts.client.request({
      path: "/ai-gateway/anthropic/v1/messages",
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      }),
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        stream: true,
        output_config: { effort },
        system: [
          { type: "text", text: system, cache_control: { type: "ephemeral" } },
        ],
        messages,
      }),
    });
    if (!res.body) throw new Error("model call returned no body");
    let text = "";
    let buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const ev = JSON.parse(line.slice(6));
        if (
          ev.type === "content_block_delta" &&
          ev.delta.type === "text_delta"
        ) {
          text += ev.delta.text;
          onText?.(text);
        } else if (ev.type === "error") {
          throw new Error(`model stream error: ${JSON.stringify(ev.error)}`);
        }
      }
    }
    return stripFences(text);
  }

  async function typecheck(file: string): Promise<string> {
    const config = path.join(stagingDir, `tsconfig.${file}.json`);
    await fs.writeFile(
      config,
      JSON.stringify({
        extends: tsconfig,
        compilerOptions: { incremental: false, noEmit: true },
        include: [],
        files: [path.join(stagingDir, file)],
      }),
    );
    try {
      await promisify(execFile)(
        process.execPath,
        [tsc, "-p", config, "--pretty", "false"],
        { cwd: appRoot },
      );
      return "";
    } catch (e) {
      return ((e as { stdout?: string }).stdout || String(e)).trim();
    }
  }

  /** One writer: stream, type-check, feed errors back up to MAX_FIX_ROUNDS times. */
  async function write(
    entry: DraftStatus,
    file: string,
    request: string,
    before: () => Promise<unknown> = async () => {},
    onText?: (soFar: string) => void,
  ): Promise<boolean> {
    const messages: Message[] = [{ role: "user", content: request }];
    for (let round = 0; ; round++) {
      entry.state = "writing";
      void save();
      const code = await stream(messages, round === 0 ? onText : undefined);
      await fs.writeFile(path.join(stagingDir, file), code);
      await before();
      entry.state = "type-checking";
      void save();
      const errors = await typecheck(file);
      entry.fixRounds = round;
      if (!errors) return true;
      if (round === MAX_FIX_ROUNDS) {
        entry.state = "failed";
        entry.error = errors.split("\n").slice(0, 5).join("\n");
        void save();
        return false;
      }
      const mock =
        file === "mock.ts"
          ? ""
          : `\n\nThe actual ../mock module is:\n${await fs.readFile(path.join(stagingDir, "mock.ts"), "utf8")}`;
      messages.push(
        { role: "assistant", content: code },
        {
          role: "user",
          content: `tsc reported these errors. Return the complete corrected file only.\n\n${errors}${mock}`,
        },
      );
    }
  }

  const brief = `App request: ${opts.prompt}\n\nRefinement answers: ${opts.answers || "(none)"}`;

  // The pages start as soon as the mock's typed export list has streamed, so
  // they import real names.
  let contractReady!: (contract: string) => void;
  const contract = new Promise<string>((r) => (contractReady = r));
  const mockDone = write(
    status.mock,
    "mock.ts",
    `${brief}\n\nWrite the shared ../mock module (mock.ts) that design drafts for this app will import. Export realistic, typed sample data and constants for every screen such an app needs (use clear, conventional export names). No React, no JSX, no imports.

Start the file with the contract: every exported type, then one \`export declare const name: Type;\`-style comment line per exported value, written as TypeScript comments like \`// export const trips: Trip[]\`. End the contract with the line \`${CONTRACT_END}\`, then write the definitions. Keep the contract short; drafts start from it before the rest is written.`,
    undefined,
    (soFar) => {
      const i = soFar.indexOf(CONTRACT_END);
      if (i !== -1) contractReady(stripFences(soFar.slice(0, i)));
    },
  ).then(async (ok) => {
    // No-op if the contract already streamed.
    contractReady(await fs.readFile(path.join(stagingDir, "mock.ts"), "utf8"));
    if (!ok) return false;
    await fs.copyFile(
      path.join(stagingDir, "mock.ts"),
      path.join(designDir, "mock.ts"),
    );
    status.mock.state = "compiled";
    void save();
    return true;
  });

  await Promise.all(
    status.drafts.map(async (entry, i) => {
      const file = `${entry.name}.tsx`;
      const ok = await write(
        entry,
        file,
        `${brief}\n\n${VARIANTS[i]}\n\nWrite the design page. Import sample data from "../mock", which exports exactly this (types and values; import types with \`import type\`):\n\n${await contract}`,
        () => mockDone,
      );
      if (!ok) return;
      if (!(await mockDone)) {
        entry.state = "failed";
        entry.error = "mock.ts failed to compile";
      } else {
        await fs.copyFile(
          path.join(stagingDir, file),
          path.join(pagesDir, file),
        );
        // Tailwind's Vite plugin only rescans sources when the stylesheet
        // changes, so a new page would lack its classes.
        const now = new Date();
        await fs
          .utimes(path.join(appRoot, "client/src/index.css"), now, now)
          .catch(() => {});
        entry.state = "compiled";
        entry.path = `/design/${entry.name}`;
      }
      void save();
    }),
  );
  status.done = true;
  await save();
  return status;
}

async function exists(file: string) {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function readStatus(file: string): Promise<TsxStatusFile | undefined> {
  return fs.readFile(file, "utf8").then(JSON.parse, () => undefined);
}

/**
 * Lock-in for TSX drafts: the chosen page becomes the design (`index.tsx`,
 * served at /design), or with `home` the app's home page component
 * (`client/src/pages/home/HomePage.tsx` with its mock beside it, for apps
 * with no data). The other drafts are deleted. Nothing is translated: only
 * the `../mock` import is repointed to `./mock`.
 */
export async function lockInTsxDraft(
  appRoot: string,
  name: string,
  { home = false }: { home?: boolean } = {},
): Promise<string> {
  const designDir = path.join(appRoot, "client/src/design");
  const pagesDir = path.join(designDir, "pages");
  const stagingDir = path.join(designDir, ".staging");
  const status = await readStatus(path.join(stagingDir, "status.json"));
  const names = status?.drafts.map((d) => d.name) ?? [];
  if (!names.includes(name)) {
    throw new Error(
      `No TSX draft named "${name}". Drafts of the last run: ${names.join(", ") || "none"}.`,
    );
  }
  const source = path.join(pagesDir, `${name}.tsx`);
  if (!(await exists(source))) {
    throw new Error(`Draft "${name}" never compiled (no ${source}).`);
  }
  const code = (await fs.readFile(source, "utf8")).replace(
    /(from\s+["'])\.\.\/mock(["'])/g,
    "$1./mock$2",
  );
  const targetDir = home
    ? path.join(appRoot, "client/src/pages/home")
    : designDir;
  const target = path.join(targetDir, home ? "HomePage.tsx" : "index.tsx");
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(target, code);
  if (home) {
    await fs.rename(
      path.join(designDir, "mock.ts"),
      path.join(targetDir, "mock.ts"),
    );
  }
  for (const n of names) {
    await fs.rm(path.join(pagesDir, `${n}.tsx`), { force: true });
  }
  await fs.rm(stagingDir, { recursive: true, force: true });
  return target;
}
