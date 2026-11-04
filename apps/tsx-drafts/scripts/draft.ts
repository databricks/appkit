// Writes 3 TSX design drafts (+ a shared mock.ts) for one prompt and times each step.
//
//   node scripts/draft.ts --prompt "..." --answers "..." [--name dash] [--model ...] [--effort low|medium|high] [--url http://localhost:8000] [--shots <dir>]
//
// Auth: AppKit's workspace client (DATABRICKS_CONFIG_PROFILE / ~/.databrickscfg);
// requests go to <host>/ai-gateway/anthropic/v1/messages.
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

import { createWorkspaceClient } from "@databricks/appkit";
import { chromium } from "@playwright/test";

const { values: args } = parseArgs({
  options: {
    prompt: { type: "string" },
    answers: { type: "string", default: "" },
    name: { type: "string", default: "draft" },
    model: { type: "string", default: "system.ai.claude-sonnet-5-5" },
    // Sonnet 5.5 thinks by default (and rejects thinking: disabled); low effort skips it.
    effort: { type: "string", default: "low" },
    url: { type: "string", default: "http://localhost:8000" },
    shots: { type: "string" },
  },
});
if (!args.prompt) throw new Error("--prompt is required");

const root = path.resolve(import.meta.dirname, "..");
const designDir = path.join(root, "client/src/design");
const stagingDir = path.join(designDir, ".staging");
const pagesDir = path.join(designDir, "pages");
const tsc = path.join(root, "node_modules/.bin/tsc");
const MAX_FIX_ROUNDS = 2;

const client = createWorkspaceClient();

const promptDir = path.join(import.meta.dirname, "prompt");
const [schema, examplePage, exampleMock] = await Promise.all(
  ["components.schema.json", "example-page.tsx", "example-mock.ts"].map((f) =>
    readFile(path.join(promptDir, f), "utf8"),
  ),
);

// Identical across all 4 writers and all runs, so it is the cached prefix.
const SYSTEM = `You write design drafts for Databricks Apps as a single React + TypeScript file.

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

const VARIANTS = [
  "Direction A: the most conventional, information-dense layout for this kind of app.",
  "Direction B: a bolder, more spacious layout with strong visual hierarchy and one hero element.",
  "Direction C: a compact, tool-like layout optimized for repeated daily use (sidebar or split panes welcome).",
];

type Message = { role: "user" | "assistant"; content: string };

async function stream(
  messages: Message[],
  onFirstToken: () => void,
  onText?: (soFar: string) => void,
): Promise<string> {
  const headers = new Headers({
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  });
  // Throws ApiError on a non-2xx status; the body is left unread so it can stream.
  const res = await client.request({
    path: "/ai-gateway/anthropic/v1/messages",
    method: "POST",
    headers,
    body: JSON.stringify({
      model: args.model,
      max_tokens: 16000,
      stream: true,
      output_config: { effort: args.effort },
      system: [
        { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
      ],
      messages,
    }),
  });
  if (!res.body) throw new Error("model call returned no body");

  let text = "";
  let buf = "";
  let first = true;
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        if (first) {
          first = false;
          onFirstToken();
        }
        text += ev.delta.text;
        onText?.(text);
      } else if (ev.type === "message_start") {
        const u = ev.message.usage;
        usage.push({
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
        });
      } else if (ev.type === "error") {
        throw new Error(`model stream error: ${JSON.stringify(ev.error)}`);
      }
    }
  }
  return stripFences(text);
}
const usage: { cacheRead: number; cacheWrite: number }[] = [];

const stripFences = (s: string) =>
  s
    .replace(/^\s*```\w*\n/, "")
    .replace(/\n```\s*$/, "")
    .trim() + "\n";

async function typecheck(files: string[]): Promise<string> {
  const config = path.join(
    stagingDir,
    `tsconfig.${path.basename(files[0])}.json`,
  );
  await writeFile(
    config,
    JSON.stringify({ extends: "../../../tsconfig.json", include: [], files }),
  );
  try {
    await promisify(execFile)(tsc, ["-p", config, "--pretty", "false"], {
      cwd: root,
    });
    return "";
  } catch (e) {
    return ((e as { stdout?: string }).stdout ?? String(e)).trim();
  }
}

type Result = {
  name: string;
  contractAt?: number;
  ttft?: number;
  fileWritten?: number;
  typecheckPassed?: number;
  rendered?: number;
  fixRounds: number;
  roundErrors?: string[][];
  status: "ok" | "failed";
  error?: string;
};

const t0 = performance.now();
const since = () => Math.round(performance.now() - t0) / 1000;

/** One writer: stream the file, type-check, feed errors back up to MAX_FIX_ROUNDS times. */
async function write(
  result: Result,
  file: string,
  request: string,
  before: () => Promise<unknown> = async () => {},
  onText?: (soFar: string) => void,
): Promise<boolean> {
  const messages: Message[] = [{ role: "user", content: request }];
  for (let round = 0; ; round++) {
    const code = await stream(
      messages,
      () => (result.ttft ??= since()),
      round === 0 ? onText : undefined,
    );
    await writeFile(path.join(stagingDir, file), code);
    result.fileWritten ??= since();
    await before();
    const errors = await typecheck([file]);
    if (!errors) {
      result.typecheckPassed = since();
      result.fixRounds = round;
      return true;
    }
    (result.roundErrors ??= []).push(
      errors
        .split("\n")
        .filter((l) => l.includes("error TS"))
        .slice(0, 8),
    );
    if (round === MAX_FIX_ROUNDS) {
      result.fixRounds = round;
      result.status = "failed";
      result.error = errors.split("\n").slice(0, 5).join("\n");
      return false;
    }
    const mock =
      file === "mock.ts"
        ? ""
        : `\n\nThe actual ../mock module is:\n${await readFile(path.join(stagingDir, "mock.ts"), "utf8")}`;
    messages.push(
      { role: "assistant", content: code },
      {
        role: "user",
        content: `tsc reported these errors. Return the complete corrected file only.\n\n${errors}${mock}`,
      },
    );
  }
}

const brief = `App request: ${args.prompt}\n\nRefinement answers: ${args.answers || "(none)"}`;
// mock.ts is shared by one app's drafts, so a new prompt replaces the previous drafts.
await rm(stagingDir, { recursive: true, force: true });
await rm(pagesDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });
await mkdir(pagesDir, { recursive: true });

const CONTRACT_END = "// @end-contract";
// The drafts start as soon as the mock's typed export list has streamed, so they import real names.
let contractReady!: (contract: string) => void;
const contract = new Promise<string>((r) => (contractReady = r));

const mockResult: Result = { name: "mock.ts", fixRounds: 0, status: "ok" };
const mockDone = write(
  mockResult,
  "mock.ts",
  `${brief}\n\nWrite the shared ../mock module (mock.ts) that design drafts for this app will import. Export realistic, typed sample data and constants for every screen such an app needs (use clear, conventional export names). No React, no JSX, no imports.

Start the file with the contract: every exported type, then one \`export declare const name: Type;\`-style comment line per exported value, written as TypeScript comments like \`// export const trips: Trip[]\`. End the contract with the line \`${CONTRACT_END}\`, then write the definitions. Keep the contract short; drafts start from it before the rest is written.`,
  undefined,
  (soFar) => {
    const i = soFar.indexOf(CONTRACT_END);
    if (i !== -1) contractReady(stripFences(soFar.slice(0, i)));
  },
).then(async (ok) => {
  contractReady(await readFile(path.join(stagingDir, "mock.ts"), "utf8")); // no-op if the contract already streamed
  if (!ok) throw new Error(`mock.ts failed:\n${mockResult.error}`);
  await copyFile(
    path.join(stagingDir, "mock.ts"),
    path.join(designDir, "mock.ts"),
  );
});

const browser = await chromium.launch({ channel: "chrome" });
const results: Result[] = VARIANTS.map((_, i) => ({
  name: `${args.name}-${"abc"[i]}`,
  fixRounds: 0,
  status: "ok",
}));

// The builder UI polls this file; rename keeps readers from seeing a half-written one.
const statusFile = path.join(designDir, "status.json");
const saveStatus = async (done: boolean) => {
  const body = {
    prompt: args.prompt,
    answers: args.answers,
    done,
    elapsed: since(),
    results: [mockResult, ...results],
    usage,
  };
  await writeFile(`${statusFile}.tmp`, JSON.stringify(body, null, 2));
  await rename(`${statusFile}.tmp`, statusFile);
};
const ticker = setInterval(() => void saveStatus(false), 300);

await Promise.all(
  results.map(async (result, i) => {
    const file = `${result.name}.tsx`;
    const mockContract = await contract;
    result.contractAt = since();
    const ok = await write(
      result,
      file,
      `${brief}\n\n${VARIANTS[i]}\n\nWrite the design page. Import sample data from "../mock", which exports exactly this (types and values; import types with \`import type\`):\n\n${mockContract}`,
      () => mockDone,
    );
    if (!ok) return;
    await copyFile(path.join(stagingDir, file), path.join(pagesDir, file));
    // Tailwind's Vite plugin only rescans sources when the stylesheet changes, so new pages lack their classes.
    const now = new Date();
    await utimes(path.join(root, "client/src/index.css"), now, now);

    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    // Vite picks the new page up via import.meta.glob; retry until the route knows it.
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.goto(`${args.url}/design/${result.name}`);
      const hit = await page
        .waitForSelector("[data-draft-ready] > *, [data-draft-error]", {
          timeout: 3000,
        })
        .catch(() => null);
      if (hit) break;
    }
    if (await page.$("[data-draft-error]")) {
      result.status = "failed";
      result.error = `render: ${await page.textContent("[data-draft-error]")}`;
    } else {
      result.rendered = since();
      if (pageErrors.length) result.error = `console: ${pageErrors[0]}`;
    }
    if (args.shots) {
      await mkdir(args.shots, { recursive: true });
      await page.waitForTimeout(1500); // let charts animate in
      await page.screenshot({
        path: path.join(args.shots, `${result.name}-light.png`),
        fullPage: true,
      });
      await page.goto(`${args.url}/design/${result.name}?theme=dark`);
      await page.waitForSelector("[data-draft-ready] > *");
      await page.waitForTimeout(1500);
      await page.screenshot({
        path: path.join(args.shots, `${result.name}-dark.png`),
        fullPage: true,
      });
    }
    await page.close();
  }),
);
await browser.close();

const all = [mockResult, ...results];
const cell = (n?: number) => (n === undefined ? "-" : `${n.toFixed(1)}s`);
console.log(
  `\nprompt: ${args.prompt}\nmodel: ${args.model} (effort ${args.effort})\n`,
);
console.log(
  "| draft | mock contract | first token | file written | type-check passed | rendered | fix rounds | status |",
);
console.log("|---|---|---|---|---|---|---|---|");
for (const r of all) {
  console.log(
    `| ${r.name} | ${cell(r.contractAt)} | ${cell(r.ttft)} | ${cell(r.fileWritten)} | ${cell(r.typecheckPassed)} | ${cell(r.rendered)} | ${r.fixRounds} | ${r.status}${r.error ? `: ${r.error.split("\n")[0]}` : ""} |`,
  );
}
const ready = results.map((r) => r.rendered).filter((t) => t !== undefined);
console.log(
  `\nall drafts ready: ${ready.length === results.length ? cell(Math.max(...ready)) : `${ready.length}/3 rendered`}`,
);
console.log("\nopen:");
for (const r of results)
  console.log(
    `  ${r.status === "ok" ? "" : "(failed) "}${args.url}/design/${r.name}  (dark: ?theme=dark)`,
  );
console.log(
  `cache: ${usage.map((u) => `read ${u.cacheRead}/write ${u.cacheWrite}`).join(", ")}`,
);
clearInterval(ticker);
await saveStatus(true);
