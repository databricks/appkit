import { describe, expect, test, vi } from "vitest";
import { ServiceManager } from "../service-manager";

function mockService(name: string, calls: string[]) {
  return {
    instance: { name },
    stop: vi.fn(async () => {
      calls.push(`stop:${name}`);
    }),
  };
}

describe("ServiceManager", () => {
  test("get<T> returns the registered instance", () => {
    const sm = new ServiceManager();
    const svc = { instance: { hello: "world" }, stop: vi.fn() };
    sm.add("greeter", svc);

    expect(sm.get<{ hello: string }>("greeter")).toEqual({ hello: "world" });
  });

  test("get<T> returns null for unknown service", () => {
    const sm = new ServiceManager();
    expect(sm.get("missing")).toBeNull();
  });

  test("add(null) is a no-op (opt-out pattern)", async () => {
    const sm = new ServiceManager();
    sm.add("absent", null);

    expect(sm.get("absent")).toBeNull();
    await expect(sm.stop()).resolves.toBeUndefined();
  });

  test("stop() invokes services in reverse add order", async () => {
    const calls: string[] = [];
    const sm = new ServiceManager();
    sm.add("a", mockService("a", calls));
    sm.add("b", mockService("b", calls));
    sm.add("c", mockService("c", calls));

    await sm.stop();

    expect(calls).toEqual(["stop:c", "stop:b", "stop:a"]);
  });

  test("stop() continues when one service throws", async () => {
    const calls: string[] = [];
    const sm = new ServiceManager();
    sm.add("a", mockService("a", calls));
    sm.add("b", {
      instance: {},
      stop: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    sm.add("c", mockService("c", calls));

    await expect(sm.stop()).resolves.toBeUndefined();
    expect(calls).toEqual(["stop:c", "stop:a"]);
  });

  test("stop() drains the registry (idempotent on second call)", async () => {
    const calls: string[] = [];
    const sm = new ServiceManager();
    sm.add("a", mockService("a", calls));

    await sm.stop();
    await sm.stop();

    expect(calls).toEqual(["stop:a"]);
    expect(sm.get("a")).toBeNull();
  });
});
