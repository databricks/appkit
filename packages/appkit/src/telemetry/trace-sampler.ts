import type { Attributes, Context, Link } from "@opentelemetry/api";
import type { Sampler, SamplingResult } from "@opentelemetry/sdk-trace-base";
import { SamplingDecision } from "@opentelemetry/sdk-trace-base";
import { shouldExcludePath } from "../utils/path-exclusions";

/**
 * Custom sampler that filters out asset requests and other noise.
 *
 * This acts as a secondary filter after HttpInstrumentation.ignoreIncomingRequestHook.
 * It catches any spans that slip through the primary filter.
 */
export class AppKitSampler implements Sampler {
  shouldSample(
    _context: Context,
    _traceId: string,
    spanName: string,
    _spanKind: number,
    attributes: Attributes,
    _links: Link[],
  ): SamplingResult {
    // Check if this is an HTTP request span
    const httpTarget = attributes["http.target"] as string | undefined;
    const httpRoute = attributes["http.route"] as string | undefined;
    const httpUrl = attributes["http.url"] as string | undefined;

    // Try to extract path from various attributes
    let path = httpTarget || httpRoute;
    if (!path && httpUrl) {
      try {
        path = new URL(httpUrl).pathname;
      } catch {
        // Not a valid URL, use as-is
        path = httpUrl;
      }
    }
    if (!path) {
      path = spanName;
    }

    // Check if path should be excluded
    if (shouldExcludePath(path)) {
      return {
        decision: SamplingDecision.NOT_RECORD,
      };
    }

    // For all other requests, record and sample
    return {
      decision: SamplingDecision.RECORD_AND_SAMPLED,
    };
  }

  toString(): string {
    return "AppKitSampler";
  }
}
