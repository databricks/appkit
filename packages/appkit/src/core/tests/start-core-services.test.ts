import { beforeEach, describe, expect, test, vi } from "vitest";

const { cacheBoot, telemetryBoot, taskBoot } = vi.hoisted(() => ({
  cacheBoot: vi.fn(async () => ({ instance: {}, stop: vi.fn() })),
  telemetryBoot: vi.fn(async () => null),
  taskBoot: vi.fn(async () => ({ instance: {}, stop: vi.fn() })),
}));

vi.mock("../../cache", () => ({
  CacheManager: { boot: cacheBoot },
}));

vi.mock("../../telemetry", () => ({
  TelemetryManager: { boot: telemetryBoot },
}));

vi.mock("../../tasks", () => ({
  TaskManager: { boot: taskBoot },
}));

import { startCoreServices } from "../service-manager";

describe("startCoreServices task boot", () => {
  beforeEach(() => {
    cacheBoot.mockClear();
    telemetryBoot.mockClear();
    taskBoot.mockClear();
  });

  test("does not boot TaskManager when task config is omitted", async () => {
    const services = await startCoreServices({});

    expect(taskBoot).not.toHaveBeenCalled();
    expect(services.get("task")).toBeNull();
  });

  test("does not boot TaskManager when task is false", async () => {
    const services = await startCoreServices({ task: false });

    expect(taskBoot).not.toHaveBeenCalled();
    expect(services.get("task")).toBeNull();
  });

  test("boots TaskManager when task is true", async () => {
    const services = await startCoreServices({ task: true });

    expect(taskBoot).toHaveBeenCalledWith(true);
    expect(services.get("task")).toEqual({});
  });

  test("boots TaskManager when task config is provided", async () => {
    const taskConfig = {
      storage: { backend: "sqlite" as const, databasePath: ".appkit/test.db" },
    };

    await startCoreServices({ task: taskConfig });

    expect(taskBoot).toHaveBeenCalledWith(taskConfig);
  });
});
