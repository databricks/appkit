import { afterEach } from "vitest";

afterEach(() => {
  window.sessionStorage.clear();
  Reflect.deleteProperty(
    globalThis,
    Symbol.for("@databricks/app-analytics/session-v1"),
  );
});
