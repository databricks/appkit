import { Command } from "commander";

import { createWorkspaceClient } from "../../../workspace-client";
import { lockInTsxDraft, systemPrompt, writeTsxDrafts } from "./tsx-drafts";

const tsxDraftsCommand = new Command("tsx-drafts")
  .description(
    "Write a shared client/src/design/mock.ts and 3 TSX design drafts at client/src/design/pages/<name>-a|b|c.tsx (served at /design/<name>-a…), type-checked with up to 2 fix rounds. Progress is in GET /design/__status (tsx).",
  )
  .requiredOption("--prompt <text>", "The app request")
  .option("--answers <text>", "Refinement answers", "")
  .option("--name <name>", "Draft name prefix", "draft")
  .option("--model <id>", "AI Gateway model", "system.ai.claude-sonnet-5-5")
  .option("--effort <level>", "low | medium | high", "low")
  .option("--profile <name>", "Databricks CLI profile")
  .option("--tsconfig <path>", "Client tsconfig, relative to the app")
  .option("--print-prompt", "Print the cached system prompt and exit")
  .action(async (opts) => {
    if (opts.printPrompt) {
      console.log(await systemPrompt());
      return;
    }
    const status = await writeTsxDrafts({
      client: createWorkspaceClient(
        opts.profile ? { profile: opts.profile } : {},
      ),
      prompt: opts.prompt,
      answers: opts.answers,
      name: opts.name,
      model: opts.model,
      effort: opts.effort,
      tsconfig: opts.tsconfig,
    });
    console.log(JSON.stringify(status, null, 2));
    if (status.drafts.every((d) => d.state === "failed")) process.exitCode = 1;
  });

const lockInCommand = new Command("lock-in")
  .description(
    "Keep one TSX draft and delete the others: it becomes client/src/design/index.tsx (/design), or with --home client/src/pages/home/HomePage.tsx for apps with no data (route it at / in App.tsx).",
  )
  .argument("<name>", "Draft to keep, e.g. draft-b")
  .option("--home", "Make it the app's home page instead of /design")
  .action(async (name: string, opts: { home?: boolean }) => {
    console.log(await lockInTsxDraft(process.cwd(), name, opts));
  });

export const designCommand = new Command("design")
  .description("Design drafts for the design plugin")
  .addCommand(tsxDraftsCommand)
  .addCommand(lockInCommand);
