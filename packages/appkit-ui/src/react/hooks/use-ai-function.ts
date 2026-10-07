import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AiFunctionsClientConfig,
  AiFunctionTask,
  AiFunctionTaskInput,
  AiFunctionTaskResult,
} from "shared";

import { usePluginClientConfig } from "./use-plugin-config";

export interface UseAiFunctionResult<
  T extends AiFunctionTask = AiFunctionTask,
> {
  /** Run the task with this input. Resolves null on error or abort. */
  invoke: (
    input: AiFunctionTaskInput<T>,
  ) => Promise<AiFunctionTaskResult<T> | null>;
  /** The last successful response, or null. Reset on each invoke. */
  data: AiFunctionTaskResult<T> | null;
  /** Whether a call is in flight. */
  loading: boolean;
  /** The server's error message, or `HTTP <status>`. */
  error: string | null;
}

/**
 * Calls a named aiFunctions task: `POST /api/ai-functions/{task}/invoke`.
 *
 * `T` is an unchecked type argument. Pass `typeof yourTasks.name` (with
 * `import type`) to type the input and `data`; nothing checks that it
 * matches `task`.
 */
export function useAiFunction<T extends AiFunctionTask = AiFunctionTask>(
  task: string,
): UseAiFunctionResult<T> {
  type TResult = AiFunctionTaskResult<T>;
  const config =
    usePluginClientConfig<Partial<AiFunctionsClientConfig>>("aiFunctions");

  const taskError = useMemo(() => {
    const tasks = config.tasks;
    if (!tasks || Object.hasOwn(tasks, task)) return null;
    return `No task configured with name "${task}". Available: ${Object.keys(tasks).join(", ")}`;
  }, [config.tasks, task]);

  const [data, setData] = useState<TResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  // Aborts the in-flight call when `task` changes and on unmount, and clears
  // the previous task's state (an aborted call never resets `loading`).
  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      setLoading(false);
      setData(null);
      setError(null);
    },
    [task],
  );

  const invoke = useCallback(
    (input: AiFunctionTaskInput<T>): Promise<TResult | null> => {
      controllerRef.current?.abort();
      if (taskError) {
        // Abort and reset first, so an earlier call can't overwrite the error.
        controllerRef.current = null;
        setLoading(false);
        setData(null);
        setError(taskError);
        return Promise.resolve(null);
      }
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
      setError(null);
      setData(null);

      return fetch(`/api/ai-functions/${encodeURIComponent(task)}/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.error || `HTTP ${res.status}`);
          }
          return res.json() as Promise<TResult>;
        })
        .then((result) => {
          if (controller.signal.aborted) return null;
          setData(result);
          setLoading(false);
          return result;
        })
        .catch((err: Error) => {
          if (controller.signal.aborted) return null;
          setError(err.message || "Request failed");
          setLoading(false);
          return null;
        });
    },
    [task, taskError],
  );

  return { invoke, data, loading, error };
}
