import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import {
  getCallerContext,
  getCurrentActorId,
} from "../context/execution-context";
import { ServiceContext } from "../context/service-context";

/** Attach identity at span creation, including cache, tool, and connector spans. */
export class ExecutionSpanProcessor implements SpanProcessor {
  onStart(span: Span, _parent: Context): void {
    const caller = getCallerContext();
    span.setAttribute("appkit.execution.principal", caller ? "user" : "app");
    span.setAttribute(
      "appkit.execution.principal_id",
      caller?.principal.userId ??
        (ServiceContext.isInitialized()
          ? ServiceContext.get().serviceUserId
          : "app"),
    );
    const actor = getCurrentActorId();
    if (actor) span.setAttribute("appkit.execution.actor_id", actor);
  }
  onEnd(_span: ReadableSpan): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}
