import type { DescMessage, MessageShape } from "@bufbuild/protobuf";
import type express from "express";
import type { IAppRouter, PluginExecutionSettings } from "shared";
import { getWorkspaceClient } from "../../context";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { ProtoSerializer } from "../proto/serialization";
import { aggregateResults, computeAppeval100 } from "./aggregator";
import { createArtifactPaths } from "./artifact-paths";
import {
  DEFAULT_APPS_VOLUME,
  DEFAULT_MLFLOW_EXPERIMENT,
  evalVolumeDefaults,
} from "./defaults";
import manifest from "./manifest.json";
import type { EvalArtifactPaths, IEvalConfig } from "./types";

const logger = createLogger("eval");

/**
 * Eval Pipeline plugin for AppKit.
 *
 * Provides structured eval pipeline operations with proto-defined data
 * contracts. Replaces JSON file I/O in the Python eval pipeline with
 * typed protobuf serialization for clean interfaces between stages.
 *
 * Pipeline stages:
 * 1. Generation → writes GenerationResult.pb
 * 2. Evaluation → reads app zip, writes EvalResult.pb
 * 3. Editing → reads app zip, writes EditResult + edited zip
 * 4. Edit Evaluation → reads both zips, writes EditEvalResult.pb
 * 5. Aggregation → reads all results, writes AggregateReport.pb
 */
export class EvalPlugin extends Plugin<IEvalConfig> {
  static manifest = manifest as PluginManifest<"eval">;

  protected declare config: IEvalConfig;

  private serializer: ProtoSerializer;
  private paths: EvalArtifactPaths;

  constructor(config: IEvalConfig) {
    super(config);
    this.config = config;
    this.serializer = new ProtoSerializer();
    this.paths = createArtifactPaths(
      config.appsVolume ?? DEFAULT_APPS_VOLUME,
    );
  }

  /**
   * Get the artifact path resolver.
   */
  getArtifactPaths(): EvalArtifactPaths {
    return this.paths;
  }

  /**
   * Write a proto message to the eval volume.
   * Wraps serialization + volume upload with retry/timeout.
   */
  async writeResult<T extends DescMessage>(
    schema: T,
    message: MessageShape<T>,
    volumePath: string,
  ): Promise<void> {
    const settings: PluginExecutionSettings = {
      default: evalVolumeDefaults,
    };

    await this.execute(async () => {
      await this.serializer.writeToVolume(schema, message, volumePath);
    }, settings);

    logger.debug("Wrote eval result to %s", volumePath);
  }

  /**
   * Read a proto message from the eval volume.
   * Wraps download + deserialization with retry/timeout.
   */
  async readResult<T extends DescMessage>(
    schema: T,
    volumePath: string,
  ): Promise<MessageShape<T> | undefined> {
    const settings: PluginExecutionSettings = {
      default: evalVolumeDefaults,
    };

    return this.execute(
      async () => this.serializer.readFromVolume(schema, volumePath),
      settings,
    );
  }

  /**
   * List all eval result files for a run.
   * Filters by pattern: run_{runId}_*_eval.pb
   */
  async listRunResults(runId: string): Promise<string[]> {
    const client = getWorkspaceClient();
    const volume = this.config.appsVolume ?? DEFAULT_APPS_VOLUME;

    const settings: PluginExecutionSettings = {
      default: evalVolumeDefaults,
    };

    const entries = await this.execute(async () => {
      return client.files.listDirectoryContents(volume);
    }, settings);

    if (!entries) return [];

    const prefix = `run_${runId}_`;
    const suffix = "_eval.pb";
    const results: string[] = [];

    for await (const entry of entries) {
      const name = entry.name ?? "";
      if (name.startsWith(prefix) && name.endsWith(suffix)) {
        results.push(`${volume}/${name}`);
      }
    }

    return results;
  }

  /**
   * Compute appeval_100 score from metrics.
   * Convenience wrapper around the aggregator function.
   */
  computeAppeval100(metrics: {
    buildSuccess: boolean;
    unitTestsPass: boolean;
    smokeTestsPass: boolean;
    typeSafetyPass: boolean;
    localRunability: number;
    appsValidatePass: boolean;
  }): number {
    return computeAppeval100(metrics);
  }

  /**
   * Aggregate eval and edit-eval results.
   * Convenience wrapper around the aggregator function.
   */
  aggregate = aggregateResults;

  injectRoutes(router: IAppRouter): void {
    // Health/status endpoint
    this.route(router, {
      name: "health",
      method: "get",
      path: "/health",
      handler: async (_req: express.Request, res: express.Response) => {
        res.json({
          status: "ok",
          appsVolume: this.config.appsVolume ?? DEFAULT_APPS_VOLUME,
          mlflowExperiment:
            this.config.mlflowExperiment ?? DEFAULT_MLFLOW_EXPERIMENT,
        });
      },
    });

    // List results for a run
    this.route(router, {
      name: "list-results",
      method: "get",
      path: "/runs/:runId/results",
      handler: async (req: express.Request, res: express.Response) => {
        try {
          const { runId } = req.params;
          const results = await this.listRunResults(runId);
          res.json({ runId, results, count: results.length });
        } catch (error) {
          logger.error("Failed to list run results: %O", error);
          res.status(500).json({
            error: error instanceof Error ? error.message : "List failed",
            plugin: this.name,
          });
        }
      },
    });
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
    logger.info("Eval plugin shut down");
  }

  /**
   * Returns the public API for the eval plugin.
   */
  exports() {
    return {
      getArtifactPaths: this.getArtifactPaths.bind(this),
      writeResult: this.writeResult.bind(this),
      readResult: this.readResult.bind(this),
      listRunResults: this.listRunResults.bind(this),
      computeAppeval100: this.computeAppeval100.bind(this),
      aggregate: this.aggregate,
    };
  }
}

/**
 * @internal
 */
export const evalPlugin = toPlugin(EvalPlugin);
