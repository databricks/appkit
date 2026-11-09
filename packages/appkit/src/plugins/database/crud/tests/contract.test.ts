import { describe, expect, it } from "vitest";

import { MAX_SERIALIZED_DEPTH, MAX_SERIALIZED_NODES } from "../../defaults";
import { boundedJson } from "../contract";

describe("boundedJson", () => {
  it("keeps finite JSON and drops undefined object entries", () => {
    expect(
      boundedJson({
        id: 1,
        label: "Ada",
        tags: ["a", "b"],
        skipped: undefined,
      }),
    ).toEqual({ id: 1, label: "Ada", tags: ["a", "b"] });
  });

  it("rejects values that are not bounded JSON", () => {
    const cyclic: Record<string, unknown> = { id: 1 };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = {};
    for (let level = 0; level <= MAX_SERIALIZED_DEPTH; level += 1) {
      deep = { deep };
    }
    const wide = Array.from({ length: MAX_SERIALIZED_NODES }, () => 1);
    for (const broken of [
      cyclic,
      deep,
      wide,
      { id: Number.POSITIVE_INFINITY },
      { at: new Date() },
    ]) {
      expect(() => boundedJson(broken)).toThrow(
        expect.objectContaining({
          category: "INVALID_REQUEST",
          phase: "write",
        }),
      );
    }
  });

  it("carries a __proto__ key as data rather than dropping it", () => {
    const sanitized = boundedJson({
      computed: JSON.parse('{"__proto__":{"owned":true},"keep":1}'),
    }) as { computed: unknown };

    expect(JSON.stringify(sanitized.computed)).toBe(
      '{"__proto__":{"owned":true},"keep":1}',
    );
    expect(({} as Record<string, unknown>).owned).toBeUndefined();
  });
});
