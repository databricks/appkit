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
  { state: "RUNNING", mode: "blocking", expected: "proceed" },

  { state: "STARTING", mode: "blocking", expected: "waitThenProceed" },

  // Stopped/stopping in blocking mode is worth starting + waiting, not fatal.
  { state: "STOPPED", mode: "blocking", expected: "startWaitProceed" },
  { state: "STOPPING", mode: "blocking", expected: "startWaitProceed" },

  // Only a deleted/deleting warehouse is a hard failure.
  { state: "DELETED", mode: "blocking", expected: "fatal" },
  { state: "DELETING", mode: "blocking", expected: "fatal" },

  // Unknown state: backstop is the describe loop, so don't block.
  { state: "WEIRD_FUTURE_STATE", mode: "blocking", expected: "proceed" },

  // `non-blocking` never describes: every state (even RUNNING) maps to degradeAll.
  { state: "RUNNING", mode: "non-blocking", expected: "degradeAll" },
  { state: "STARTING", mode: "non-blocking", expected: "degradeAll" },
  { state: "STOPPED", mode: "non-blocking", expected: "degradeAll" },
  { state: "STOPPING", mode: "non-blocking", expected: "degradeAll" },
  { state: "DELETED", mode: "non-blocking", expected: "degradeAll" },
  { state: "DELETING", mode: "non-blocking", expected: "degradeAll" },
  { state: "WEIRD_FUTURE_STATE", mode: "non-blocking", expected: "degradeAll" },
];

describe("decidePreflight", () => {
  test.each(cases)(
    "$state + $mode -> $expected",
    ({ state, mode, expected }) => {
      expect(decidePreflight(state as WarehouseState, mode)).toBe(expected);
    },
  );
});
