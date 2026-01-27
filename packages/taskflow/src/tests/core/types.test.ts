import { describe, expect, it } from "vitest";
import {
  isTerminalStatus,
  isValidTransition,
  VALID_TRANSITIONS,
  type TaskStatus,
  type TaskType,
} from "@/core/types";

describe("Core Types", () => {
  describe("TaskStatus", () => {
    it("should have all valid statuses", () => {
      const statuses: TaskStatus[] = [
        "created",
        "running",
        "completed",
        "failed",
        "cancelled",
      ];
      expect(statuses).toHaveLength(5);
    });
  });

  describe("TaskType", () => {
    it("should have user and background options", () => {
      const types: TaskType[] = ["user", "background"];
      expect(types).toHaveLength(2);
    });
  });

  describe("VALID_TRANSITIONS", () => {
    it("should define valid transitions for created", () => {
      expect(VALID_TRANSITIONS.created).toEqual(["running", "cancelled"]);
    });
    it("should define valid transitions for running", () => {
      expect(VALID_TRANSITIONS.running).toEqual([
        "completed",
        "failed",
        "cancelled",
      ]);
    });
    it("should define no transitions for completed", () => {
      expect(VALID_TRANSITIONS.completed).toEqual([]);
    });
    it("should define reset transition for failed", () => {
      expect(VALID_TRANSITIONS.failed).toEqual(["created"]);
    });
    it("should define no transitions for cancelled", () => {
      expect(VALID_TRANSITIONS.cancelled).toEqual([]);
    });
  });

  describe("isValidTransition", () => {
    it("should return true for valid transitions", () => {
      expect(isValidTransition("created", "running")).toBe(true);
      expect(isValidTransition("created", "cancelled")).toBe(true);
      expect(isValidTransition("running", "completed")).toBe(true);
      expect(isValidTransition("running", "failed")).toBe(true);
      expect(isValidTransition("running", "cancelled")).toBe(true);
      expect(isValidTransition("failed", "created")).toBe(true);
    });
    it("should return false for invalid transitions", () => {
      expect(isValidTransition("created", "completed")).toBe(false);
      expect(isValidTransition("created", "failed")).toBe(false);
      expect(isValidTransition("completed", "running")).toBe(false);
      expect(isValidTransition("completed", "created")).toBe(false);
      expect(isValidTransition("cancelled", "running")).toBe(false);
      expect(isValidTransition("running", "created")).toBe(false);
    });
  });
  describe("isTerminalStatus", () => {
    it("should return true for terminal statuses", () => {
      expect(isTerminalStatus("completed")).toBe(true);
      expect(isTerminalStatus("failed")).toBe(true);
      expect(isTerminalStatus("cancelled")).toBe(true);
    });
    it("should return false for non-terminal statuses", () => {
      expect(isTerminalStatus("created")).toBe(false);
      expect(isTerminalStatus("running")).toBe(false);
    });
  });
});
