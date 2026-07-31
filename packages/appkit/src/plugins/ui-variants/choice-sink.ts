import fs from "node:fs/promises";
import path from "node:path";
import { getEphemeralStateDir } from "shared";

/**
 * Filename of the JSONL choices file. The agent skill discovers this file at
 * the ephemeral state directory (under node_modules/).
 */
const UI_CHOICES_FILENAME = ".appkit-ui-choices.jsonl";

/**
 * Default absolute path to the JSONL choices file: ephemeral state dir
 * (node_modules/.databricks/appkit/) + the contract filename. Kept
 * ephemeral & gitignored; NOT part of the committed .appkit/ relocation.
 *
 * A coding agent reads it to pick up the developer's in-browser confirmation
 * and finalize the chosen variant. Each line is spent on read — the agent
 * removes it once the choice is finalized.
 *
 * CONTRACT: the `databricks-app-variants` agent skill (in the
 * databricks-agent-skills repo) discovers the choices file at this absolute
 * path. Changing this value silently breaks that skill's file discovery —
 * update the skill's `find` path in the same change.
 */
const DEFAULT_UI_CHOICES_PATH = path.join(
  getEphemeralStateDir(),
  UI_CHOICES_FILENAME,
);

/**
 * One recorded variant choice.
 *
 * CONTRACT: the `databricks-app-variants` agent skill parses these fields
 * (`blockId`, `chosenIndex`, `label`) to finalize the chosen variant. Renaming
 * or removing a field silently breaks finalization (the skill reads it from the
 * JSONL line, so there's no compile error) — update the skill in the same
 * change.
 */
export interface UiChoiceRecord {
  /** ISO timestamp of when the choice was recorded. */
  ts: string;
  /** Stable id of the `<Variants>` block the developer confirmed. */
  blockId: string;
  /** Zero-based index of the chosen `<Variant>` child. */
  chosenIndex: number;
  /** Human-readable label of the chosen variant (for agent context). */
  label?: string;
  /** Optional free-form note from the developer. */
  note?: string;
}

/**
 * File store for confirmed variant choices: upserts choices into
 * {@link DEFAULT_UI_CHOICES_PATH}, one line per `<Variants>` id.
 *
 * The store is **keyed and latest-wins**: at most one record per `blockId`, and
 * recording an existing `blockId` replaces it rather than appending, so the file
 * always reflects the current choice for each block.
 *
 * By default, the file lands at the ephemeral state directory under
 * `node_modules/.databricks/appkit/`. Callers may override the path (e.g., for
 * testing), in which case it is resolved against `process.cwd()`; absolute
 * paths are passed through unchanged. Concurrent confirms are serialized behind
 * an internal queue so their read-modify-write can't interleave and lose an
 * update.
 *
 * @internal
 */
export class FileChoiceStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(pathArg: string = DEFAULT_UI_CHOICES_PATH) {
    this.filePath = path.resolve(process.cwd(), pathArg);
  }

  record(record: UiChoiceRecord): Promise<void> {
    const run = this.writeQueue.then(() => this.upsert(record));
    // Keep the chain alive even if this write throws, but surface the error.
    this.writeQueue = run.catch(() => {});
    return run;
  }

  /**
   * Reads the current file, replaces (or adds) the line for `record.blockId`,
   * dropping any unparseable lines, and rewrites the whole file.
   */
  private async upsert(record: UiChoiceRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    let existing = "";
    try {
      existing = await fs.readFile(this.filePath, "utf-8");
    } catch {
      // File doesn't exist yet — start empty.
    }

    const kept = existing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => {
        try {
          return (
            (JSON.parse(line) as UiChoiceRecord).blockId !== record.blockId
          );
        } catch {
          // Drop unparseable lines rather than let them accumulate.
          return false;
        }
      });

    kept.push(JSON.stringify(record));
    await fs.writeFile(this.filePath, `${kept.join("\n")}\n`, "utf-8");
  }
}
