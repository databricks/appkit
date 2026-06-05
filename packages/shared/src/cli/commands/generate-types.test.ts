import { describe, expect, test } from "vitest";
import { resolveTypegenMode } from "./generate-types";

describe("resolveTypegenMode (generate-types --block)", () => {
  test("defaults to non-blocking when no options/flag are given", () => {
    // A one-shot CLI never describes by default — it emits cached/`unknown` types
    // and exits 0 instead of blocking on (or failing because of) a warehouse,
    // even a RUNNING one. The template's postinstall/predev rely on this.
    expect(resolveTypegenMode()).toBe("non-blocking");
    expect(resolveTypegenMode({})).toBe("non-blocking");
  });

  test("stays non-blocking when block is false (flag absent)", () => {
    expect(resolveTypegenMode({ block: false })).toBe("non-blocking");
  });

  test("switches to blocking when --block sets block to true", () => {
    // commander maps `--block` to `{ block: true }`. A deliberate/CI invocation
    // opts in to waiting for a starting warehouse and failing fast on a stopped
    // one.
    expect(resolveTypegenMode({ block: true })).toBe("blocking");
  });
});
