import { useCallback, useRef, useState } from "react";
import { type HeadersOption, mutateJson } from "./internal/fetch-json";

export interface ApprovalDecision {
  approvalId: string;
  streamId: string;
  decision: "approve" | "deny";
}

export interface UseSubmitApprovalOptions {
  /** URL of the approval endpoint, e.g. `"/api/agents/approve"`. */
  api: string;
  /** Optional auth/extra headers. May be a function for async resolution. */
  headers?: HeadersOption;
}

export interface UseSubmitApprovalResult {
  /**
   * POSTs `{ streamId, approvalId, decision }` to `${api}`. Resolves
   * once the server accepts the decision; rejects with a plain `Error`
   * on non-2xx (message taken from the server's `error` field when
   * present) so the caller can roll the approval card back to pending.
   */
  submit: (decision: ApprovalDecision) => Promise<void>;
  /** True while a `submit()` call is in flight. */
  loading: boolean;
  /** Last rejection from `submit()`. Cleared at the next call. */
  error: Error | null;
}

/**
 * Mutation hook for the `/approve` endpoint exposed by the agents
 * plugin. Used by `<ChatApp>` to gate destructive tool calls — the UI
 * displays a card that posts here when the user clicks Allow or Deny.
 */
export function useSubmitApproval(
  options: UseSubmitApprovalOptions,
): UseSubmitApprovalResult {
  const { api } = options;

  const headersRef = useRef(options.headers);
  headersRef.current = options.headers;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const submit = useCallback(
    async (decision: ApprovalDecision) => {
      setLoading(true);
      setError(null);
      try {
        await mutateJson(api, {
          method: "POST",
          headers: headersRef.current,
          body: {
            streamId: decision.streamId,
            approvalId: decision.approvalId,
            decision: decision.decision,
          },
        });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setLoading(false);
        throw e;
      }
      setLoading(false);
    },
    [api],
  );

  return { submit, loading, error };
}
