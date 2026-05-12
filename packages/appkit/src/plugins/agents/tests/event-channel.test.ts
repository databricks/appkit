import { describe, expect, test } from "vitest";
import { EventChannel } from "../event-channel";

async function collect<T>(ch: EventChannel<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of ch) out.push(v);
  return out;
}

describe("EventChannel", () => {
  test("yields pushed values in order", async () => {
    const ch = new EventChannel<number>();
    const p = collect(ch);
    ch.push(1);
    ch.push(2);
    ch.push(3);
    ch.close();
    await expect(p).resolves.toEqual([1, 2, 3]);
  });

  test("pushes before iteration start are buffered", async () => {
    const ch = new EventChannel<string>();
    ch.push("a");
    ch.push("b");
    ch.close();
    await expect(collect(ch)).resolves.toEqual(["a", "b"]);
  });

  test("waiting iterator is unblocked by subsequent push", async () => {
    const ch = new EventChannel<number>();
    const promise = collect(ch);
    await new Promise((r) => setTimeout(r, 5));
    ch.push(42);
    ch.close();
    await expect(promise).resolves.toEqual([42]);
  });

  test("close with no pending values terminates iteration", async () => {
    const ch = new EventChannel<number>();
    const p = collect(ch);
    ch.close();
    await expect(p).resolves.toEqual([]);
  });

  test("push after close is a no-op (channel is closed)", async () => {
    const ch = new EventChannel<number>();
    ch.close();
    ch.push(1);
    await expect(collect(ch)).resolves.toEqual([]);
  });

  test("close with error rejects the waiting iterator", async () => {
    const ch = new EventChannel<number>();
    const promise = collect(ch);
    await new Promise((r) => setTimeout(r, 5));
    ch.close(new Error("boom"));
    await expect(promise).rejects.toThrow(/boom/);
  });

  test("interleaved pushes and reads stream through", async () => {
    const ch = new EventChannel<number>();
    const received: number[] = [];
    const reader = (async () => {
      for await (const v of ch) {
        received.push(v);
        if (received.length === 3) break;
      }
    })();
    ch.push(1);
    await new Promise((r) => setTimeout(r, 0));
    ch.push(2);
    await new Promise((r) => setTimeout(r, 0));
    ch.push(3);
    await reader;
    expect(received).toEqual([1, 2, 3]);
    ch.close();
  });
});
