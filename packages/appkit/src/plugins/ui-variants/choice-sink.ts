import fs from "node:fs/promises";
import path from "node:path";

/**
 * Path of the JSONL choices file, relative to the app's working directory.
 * A coding agent reads it to pick up the developer's in-browser confirmation
 * and finalize the chosen variant.
 *
 * Under `node_modules/`, so it's gitignored and cleared on a clean install.
 * Each line is spent on read — the agent removes it once the choice is
 * finalized.
 *
 * CONTRACT: the `databricks-app-variants` agent skill (in the
 * databricks-agent-skills repo) discovers the choices file at this path.
 * Changing this value silently breaks that skill's file discovery — update the
 * skill's `find` path in the same change.
 */
const UI_CHOICES_FILE =
  "node_modules/.databricks/appkit/.appkit-ui-choices.jsonl";

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
 * Storage backend for confirmed variant choices, decoupled from the recorder
 * plugin so the destination can vary by environment. The default
 * {@link FileChoiceSink} writes a local JSONL file, suitable wherever the
 * coding agent shares the app's filesystem; an environment without a shared
 * filesystem can supply its own implementation (e.g. a table-backed store).
 *
 * Implementations must be **keyed and latest-wins**: at most one record per
 * `blockId`, and recording an existing `blockId` replaces it rather than
 * appending, so the store always reflects the current choice for each block.
 */
export interface ChoiceSink {
  /** Record (upsert) a choice, keyed by `record.blockId`. */
  record(record: UiChoiceRecord): Promise<void>;
}

/**
 * Default {@link ChoiceSink}: upserts choices into {@link UI_CHOICES_FILE},
 * one line per `<Variants>` id.
 *
 * The file is resolved against `process.cwd()`, so it lands under whatever
 * directory the dev server runs from. Concurrent confirms are serialized behind
 * an internal queue so their read-modify-write can't interleave and lose an
 * update.
 */
export class FileChoiceSink implements ChoiceSink {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(relativePath: string = UI_CHOICES_FILE) {
    this.filePath = path.resolve(process.cwd(), relativePath);
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
