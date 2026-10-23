import { describe, expect, test } from "vitest";

import { getCurrentPrincipalKey } from "../../context";
import { Plugin, toPlugin } from "../../plugin";
import { createTestApp } from "../../testing";

const manifest = {
  displayName: "Probe",
  description: "Service handle probe",
  resources: { required: [], optional: [] },
};

class LedgerPlugin extends Plugin {
  static manifest = { ...manifest, name: "ledger" as const };
  private entries = 0;
  record() {
    this.entries += 1;
    return `${getCurrentPrincipalKey()}:${this.entries}`;
  }
  exports() {
    return { record: this.record };
  }
}

class RunnerPlugin extends Plugin {
  static manifest = { ...manifest, name: "runner" as const };
  /** What a plugin running application code would hand that code. */
  serviceApi() {
    return this.context?.getServiceApi();
  }
  exports() {
    return { serviceApi: () => this.serviceApi() };
  }
}

describe("PluginContext service handle", () => {
  test("lets a plugin reach every sibling's service-principal exports", async () => {
    await using app = await createTestApp({
      plugins: [toPlugin(LedgerPlugin)(), toPlugin(RunnerPlugin)()],
      server: false,
    });

    const api = app.plugins.runner.serviceApi() as Record<string, any>;

    expect(Object.keys(api).sort()).toEqual(["ledger", "runner"]);
    expect(Object.isFrozen(api)).toBe(true);
    // The same bound handle `appkit.ledger` returns, in service scope.
    expect(api.ledger.record()).toBe("app:1");
    expect(app.plugins.ledger.record()).toBe("app:2");
  });
});
