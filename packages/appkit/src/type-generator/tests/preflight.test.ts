import { describe, expect, test } from "vitest";
import {
  decidePreflight,
  type PreflightDecision,
  type PreflightMode,
} from "../preflight";
import type { WarehouseState } from "../warehouse-status";

// Every (state × mode) pair the policy must implement, plus an unknown-state
// case that must fall through to "proceed".
const cases: Array<{
  state: WarehouseState | "WEIRD_FUTURE_STATE";
  mode: PreflightMode;
  expected: PreflightDecision;
}> = [
  { state: "RUNNING", mode: "dev", expected: "proceed" },
  { state: "RUNNING", mode: "blocking", expected: "proceed" },

  { state: "STARTING", mode: "dev", expected: "degradeAll" },
  { state: "STARTING", mode: "blocking", expected: "waitThenProceed" },

  { state: "STOPPED", mode: "dev", expected: "degradeAll" },
  { state: "STOPPED", mode: "blocking", expected: "fatal" },
  { state: "STOPPING", mode: "dev", expected: "degradeAll" },
  { state: "STOPPING", mode: "blocking", expected: "fatal" },

  { state: "DELETED", mode: "dev", expected: "fatal" },
  { state: "DELETED", mode: "blocking", expected: "fatal" },
  { state: "DELETING", mode: "dev", expected: "fatal" },
  { state: "DELETING", mode: "blocking", expected: "fatal" },

  // Unknown state: backstop is the describe loop, so don't block.
  { state: "WEIRD_FUTURE_STATE", mode: "dev", expected: "proceed" },
  { state: "WEIRD_FUTURE_STATE", mode: "blocking", expected: "proceed" },

  // `degrade` never describes: every state (even RUNNING) maps to degradeAll.
  { state: "RUNNING", mode: "degrade", expected: "degradeAll" },
  { state: "STARTING", mode: "degrade", expected: "degradeAll" },
  { state: "STOPPED", mode: "degrade", expected: "degradeAll" },
  { state: "STOPPING", mode: "degrade", expected: "degradeAll" },
  { state: "DELETED", mode: "degrade", expected: "degradeAll" },
  { state: "DELETING", mode: "degrade", expected: "degradeAll" },
  { state: "WEIRD_FUTURE_STATE", mode: "degrade", expected: "degradeAll" },
];

describe("decidePreflight", () => {
  test.each(cases)(
    "$state + $mode -> $expected",
    ({ state, mode, expected }) => {
      expect(decidePreflight(state as WarehouseState, mode)).toBe(expected);
    },
  );
});
