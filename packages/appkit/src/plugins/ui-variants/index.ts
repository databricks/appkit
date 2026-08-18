import type { BasePluginConfig, IAppRouter } from "shared";

import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { FileChoiceStore, type UiChoiceRecord } from "./choice-sink";
import manifest from "./manifest.json";

const logger = createLogger("ui-variants");

/** Untrusted body of `POST /api/ui-variants/confirm`; validated in the handler. */
interface ConfirmRequestBody {
  blockId?: unknown;
  chosenIndex?: unknown;
  label?: unknown;
  note?: unknown;
}

/**
 * Dev-only recorder backing the `<Variants>` UI picker.
 *
 * When a developer confirms a variant in the browser, the `<Variants>`
 * component POSTs to `/api/ui-variants/confirm`. This plugin records the choice
 * into a keyed JSONL file, which a coding agent reads to finalize the chosen
 * variant into the component source. Recording is a keyed upsert — one entry
 * per `<Variants>` id — and the plugin only records; it never edits source.
 */
class UiVariantsPlugin extends Plugin<BasePluginConfig> {
  static manifest = manifest as PluginManifest<"uiVariants">;

  protected static description =
    "Dev-only recorder for the <Variants> UI picker";

  private readonly store: FileChoiceStore;

  constructor(config: BasePluginConfig = {} as BasePluginConfig) {
    super(config);
    this.store = new FileChoiceStore();
  }

  injectRoutes(router: IAppRouter): void {
    this.route(router, {
      name: "confirm",
      method: "post",
      path: "/confirm",
      handler: async (req, res) => {
        // Dev-only: the recorder exists solely to drive the local edit loop,
        // so it must never run in a deployed app.
        if (process.env.NODE_ENV !== "development") {
          res.status(403).json({
            ok: false,
            message: "ui-variants confirm is only available in development",
          });
          return;
        }

        const body = (req.body ?? {}) as ConfirmRequestBody;
        const { blockId, chosenIndex } = body;

        if (typeof blockId !== "string" || blockId.length === 0) {
          res.status(400).json({
            ok: false,
            message: "`blockId` (non-empty string) is required",
          });
          return;
        }
        if (typeof chosenIndex !== "number" || !Number.isInteger(chosenIndex)) {
          res.status(400).json({
            ok: false,
            message: "`chosenIndex` (integer) is required",
          });
          return;
        }

        const record: UiChoiceRecord = {
          ts: new Date().toISOString(),
          blockId,
          chosenIndex,
          ...(typeof body.label === "string" ? { label: body.label } : {}),
          ...(typeof body.note === "string" ? { note: body.note } : {}),
        };

        try {
          await this.store.record(record);
        } catch (error) {
          logger.error("Failed to record UI variant choice", {
            error,
            blockId,
          });
          res
            .status(500)
            .json({ ok: false, message: "Failed to record variant choice" });
          return;
        }

        logger.info("Recorded UI variant choice", {
          blockId,
          chosenIndex,
          label: record.label,
        });
        res.json({ ok: true, blockId, chosenIndex });
      },
    });
  }
}

export const uiVariants = toPlugin(UiVariantsPlugin);
