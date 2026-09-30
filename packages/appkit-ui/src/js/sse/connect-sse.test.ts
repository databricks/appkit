import { afterEach, expect, test, vi } from "vitest";

import { connectSSE } from "./connect-sse";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("the deadline remains active after headers while the body stalls", async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const fetchMock = vi.fn(
    async (_url, options) =>
      new Response(
        new ReadableStream({
          start(controller) {
            options.signal.addEventListener("abort", () =>
              controller.error(options.signal.reason),
            );
          },
        }),
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const pending = connectSSE({
    url: "/stream",
    timeout: 100,
    maxRetries: 0,
    onMessage: async () => {},
    onError,
  });
  await vi.advanceTimersByTimeAsync(101);
  await pending;
  expect(onError).toHaveBeenCalledOnce();
  expect(onError.mock.calls[0][0].name).toBe("AbortError");
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("cancellation before connecting makes no request", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await connectSSE({
    url: "/stream",
    signal: controller.signal,
    onMessage: async () => {},
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("cancellation during retry backoff prevents another request", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
  const onError = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const pending = connectSSE({
    url: "/stream",
    signal: controller.signal,
    retryDelay: 100,
    onMessage: async () => {},
    onError,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledOnce();
  controller.abort();
  await pending;
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("reports retryable failures and reconnects successfully", async () => {
  vi.useFakeTimers();
  const failure = new TypeError("Failed to fetch");
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(new Response('data: {"ok":true}\n\n'));
  const onError = vi.fn();
  const onMessage = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const pending = connectSSE({
    url: "/stream",
    retryDelay: 100,
    maxRetries: 1,
    onMessage,
    onError,
  });
  await vi.advanceTimersByTimeAsync(200);
  await pending;
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure, true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(onMessage).toHaveBeenCalledExactlyOnceWith({
    id: "",
    data: '{"ok":true}',
  });
  expect(vi.getTimerCount()).toBe(0);
});

test("caller cancellation during a body read is silent", async () => {
  const controller = new AbortController();
  const onError = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (_url, options) =>
        new Response(
          new ReadableStream({
            start(stream) {
              options.signal.addEventListener("abort", () =>
                stream.error(options.signal.reason),
              );
            },
          }),
        ),
    ),
  );
  const pending = connectSSE({
    url: "/stream",
    signal: controller.signal,
    onMessage: async () => {},
    onError,
  });
  await Promise.resolve();
  controller.abort();
  await pending;
  expect(onError).not.toHaveBeenCalled();
});

test("awaits async messages before EOF and permits generic streams without terminal payloads", async () => {
  let finish!: () => void;
  const handled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onError = vi.fn();
  const onMessage = vi.fn(() => handled);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response('data: {"token":"hello"}\n\n')),
  );
  let completed = false;
  const pending = connectSSE({ url: "/stream", onMessage, onError }).then(
    () => {
      completed = true;
    },
  );
  await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
  expect(completed).toBe(false);
  finish();
  await pending;
  expect(onError).not.toHaveBeenCalled();
});
