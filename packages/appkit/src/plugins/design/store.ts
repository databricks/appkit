import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Selection file, relative to the app's working directory. */
const SELECTION_FILE = ".appkit/design-selection.json";
const SCREENSHOT_DIR = ".appkit/design-screenshots";

const DATA_URL = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/;

/** One picked element, as sent by the browser picker. */
export interface DesignElement {
  /** Nearest React component name owning the element. */
  component?: string;
  /** Owning components, innermost first. */
  stack?: string[];
  /** `file:line:col` from the element's `data-source` attribute. */
  source?: string;
  /** Serialized props of that component. */
  props?: Record<string, unknown>;
  /** Tag name of the picked DOM element. */
  tag?: string;
  /** Text content (truncated) of the picked element. */
  text?: string;
  /** PNG/JPEG data URL on input; path of the saved image file on output. */
  screenshot?: string;
}

export interface DesignSelectionInput {
  elements: DesignElement[];
  note?: string;
  /** Page the elements were picked on (`/design` or an app route). */
  url?: string;
}

interface DesignSelection extends DesignSelectionInput {
  id: string;
  ts: string;
}

interface DesignSelectionFile {
  selections: DesignSelection[];
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * Append-only store of design selections. Writes are serialized so concurrent
 * sends can't interleave their read-modify-write.
 *
 * @internal
 */
export class DesignSelectionStore {
  readonly filePath: string;
  private readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(root: string = process.cwd()) {
    this.root = root;
    this.filePath = path.resolve(root, SELECTION_FILE);
  }

  async read(): Promise<DesignSelectionFile> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, "utf-8"));
    } catch {
      return { selections: [] };
    }
  }

  add(input: DesignSelectionInput): Promise<DesignSelection> {
    return this.enqueue(async () => {
      const id = randomUUID();
      const elements = await Promise.all(
        input.elements.map((el, i) => this.toElement(el, `${id}-${i}`)),
      );
      const selection: DesignSelection = {
        id,
        ts: new Date().toISOString(),
        ...(input.note ? { note: input.note } : {}),
        ...(input.url ? { url: input.url } : {}),
        elements,
      };
      const file = await this.read();
      file.selections.push(selection);
      await this.write(file);
      return selection;
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      await fs.rm(path.resolve(this.root, SCREENSHOT_DIR), {
        recursive: true,
        force: true,
      });
      await this.write({ selections: [] });
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async write(file: DesignSelectionFile) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  /** Keeps only known fields and moves the screenshot out to an image file. */
  private async toElement(
    raw: DesignElement,
    name: string,
  ): Promise<DesignElement> {
    const el: DesignElement = {
      component: str(raw.component),
      stack: Array.isArray(raw.stack)
        ? raw.stack.filter((s) => typeof s === "string")
        : undefined,
      source: str(raw.source),
      tag: str(raw.tag),
      text: str(raw.text),
      props: raw.props && typeof raw.props === "object" ? raw.props : undefined,
    };
    const match = str(raw.screenshot)?.match(DATA_URL);
    if (match) {
      const rel = path.join(SCREENSHOT_DIR, `${name}.${match[1]}`);
      await fs.mkdir(path.resolve(this.root, SCREENSHOT_DIR), {
        recursive: true,
      });
      await fs.writeFile(
        path.resolve(this.root, rel),
        Buffer.from(match[2], "base64"),
      );
      el.screenshot = rel;
    }
    return el;
  }
}
