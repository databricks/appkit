import { describe, expect, test } from "vitest";
import { resolveTypegenMode } from "./generate-types";

describe("resolveTypegenMode (generate-types --no-block)", () => {
  test("defaults to blocking when no options/flag are given", () => {
    expect(resolveTypegenMode()).toBe("blocking");
    expect(resolveTypegenMode({})).toBe("blocking");
  });

  test("stays blocking when block is true (flag absent)", () => {
    expect(resolveTypegenMode({ block: true })).toBe("blocking");
  });

  test("switches to degrade when --no-block sets block to false", () => {
    // commander maps `--no-block` to `{ block: false }`. The template's
    // postinstall/predev use this so a one-shot CLI never describes — it emits
    // cached/`unknown` types and exits 0 instead of blocking on (or failing
    // because of) a warehouse, even a RUNNING one.
    expect(resolveTypegenMode({ block: false })).toBe("degrade");
  });
});
