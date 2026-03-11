/**
 * LangChain tracing integration for the agent plugin.
 *
 * Instruments LangChain callbacks via @arizeai/openinference-instrumentation-langchain
 * so that agent spans are emitted through the global tracer provider
 * (set up by AppKit's TelemetryManager).
 *
 * MLflow-specific headers (experiment ID, UC table name) are added
 * to the trace exporter by TelemetryManager — see buildTraceExporterHeaders().
 */

import { createLogger } from "../../logging/logger";

const logger = createLogger("agent:tracing");

/**
 * Instrument LangChain callbacks via the Arize/OpenInference library.
 *
 * The instrumentation creates spans using the **global** tracer provider
 * (registered by TelemetryManager's NodeSDK). No separate provider is needed.
 *
 * IMPORTANT: `callbackManagerModule` must be the module object that the
 * agent runtime uses (imported from agent.ts context), NOT a separate
 * import inside this file. pnpm strict isolation can resolve different
 * physical copies of @langchain/core for different packages in the
 * dependency tree, and patching the wrong copy has no effect.
 */
export async function instrumentLangChain(
  callbackManagerModule?: typeof import("@langchain/core/callbacks/manager"),
): Promise<void> {
  try {
    const { LangChainInstrumentation } = await import(
      "@arizeai/openinference-instrumentation-langchain"
    );

    const cbModule =
      callbackManagerModule ??
      (await import("@langchain/core/callbacks/manager"));

    const inst = new LangChainInstrumentation();
    inst.manuallyInstrument(cbModule);

    logger.debug("LangChain callbacks instrumented (global tracer provider)");
  } catch (err) {
    logger.error("Failed to instrument LangChain callbacks: %O", err);
  }
}
