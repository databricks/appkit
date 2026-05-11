import { describe, expect, test } from "vitest";
import { buildAppkitPayload, wrapAppkitLog } from "../appkit-log";

describe("appkit-log", () => {
  test("wrapAppkitLog produces a typed envelope", () => {
    const envelope = wrapAppkitLog({
      event_name: "HEARTBEAT",
      app_id: "id",
      appkit_version: "1.0.0",
      heartbeat_event: {},
    });
    expect(envelope.frontend_log_event_id).toMatch(/^appkit-heartbeat-/);
    expect(envelope.entry.appkit_log.event_name).toBe("HEARTBEAT");
    expect(typeof envelope.inferred_timestamp_millis).toBe("number");
  });

  test("buildAppkitPayload encodes one protoLog per log", () => {
    const payload = buildAppkitPayload([
      { event_name: "APP_STARTUP", app_startup_event: {} },
      { event_name: "HEARTBEAT", heartbeat_event: {} },
    ]);
    expect(payload.items).toEqual([]);
    expect(payload.protoLogs).toHaveLength(2);
    expect(JSON.parse(payload.protoLogs[0]).entry.appkit_log.event_name).toBe(
      "APP_STARTUP",
    );
  });
});
