import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_AUTOCAPTURE_EVENTS_PER_SESSION,
  observeAutocapture,
  type AutocaptureSignal,
} from "../autocapture";
import { createAppAnalytics, type AppAnalyticsDiagnostic } from "../index";
import {
  installFetchMock,
  readFirstLogRecord,
  readLogRecords,
  readPayload,
  readStringAttribute,
} from "./test-utils";

const AUTOCAPTURE_STATE_KEY = Symbol.for(
  "@databricks/app-analytics/autocapture-state",
);

afterEach(() => {
  // A failed assertion must not leave shared listeners for the next test.
  Reflect.deleteProperty(globalThis, AUTOCAPTURE_STATE_KEY);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("annotated autocapture", () => {
  it("observes annotated interactive clicks and form submissions", () => {
    const interactions: AutocaptureSignal[] = [];
    const stop = observeAutocapture(
      (interaction) => interactions.push(interaction),
      {},
      { isTrusted: () => true },
    );
    expect(stop).toBeTypeOf("function");

    const button = document.createElement("button");
    button.dataset.appAnalyticsEvent = "export_clicked";
    const label = document.createElement("span");
    label.textContent = "Export";
    button.append(label);

    const form = document.createElement("form");
    form.dataset.appAnalyticsEvent = "search_submitted";
    document.body.append(button, form);

    label.click();
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );

    expect(interactions).toEqual([
      { kind: "interaction", eventName: "export_clicked" },
      { kind: "interaction", eventName: "search_submitted" },
    ]);

    stop?.();
  });

  it("ignores unannotated, disabled, and excluded elements", () => {
    const listener = vi.fn();
    const stop = observeAutocapture(listener, {}, { isTrusted: () => true });

    const unannotated = document.createElement("button");

    const disabled = document.createElement("button");
    disabled.dataset.appAnalyticsEvent = "disabled_clicked";
    disabled.setAttribute("aria-disabled", "true");

    const excluded = document.createElement("div");
    excluded.dataset.appAnalyticsIgnore = "";
    const excludedButton = document.createElement("button");
    excludedButton.dataset.appAnalyticsEvent = "secret_clicked";
    excluded.append(excludedButton);

    document.body.append(unannotated, disabled, excluded);
    unannotated.click();
    disabled.click();
    excludedButton.click();

    expect(listener).not.toHaveBeenCalled();
    stop?.();
  });

  it("reports an annotation that cannot fire once per element", () => {
    const signals: AutocaptureSignal[] = [];
    const stop = observeAutocapture(
      (signal) => signals.push(signal),
      {},
      { isTrusted: () => true },
    );

    const nonInteractive = document.createElement("div");
    nonInteractive.dataset.appAnalyticsEvent = "decorative_clicked";
    const annotatedWrapper = document.createElement("section");
    annotatedWrapper.dataset.appAnalyticsEvent = "search_submitted";
    const form = document.createElement("form");
    annotatedWrapper.append(form);
    document.body.append(nonInteractive, annotatedWrapper);

    nonInteractive.click();
    nonInteractive.click();
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );

    expect(signals).toEqual([
      { kind: "ignored", reason: "not_interactive" },
      { kind: "ignored", reason: "not_interactive" },
    ]);
    stop?.();
  });

  it("rejects synthetic browser events by default", () => {
    const listener = vi.fn();
    const stop = observeAutocapture(listener);
    const button = annotatedButton("synthetic_clicked");

    button.click();

    expect(listener).not.toHaveBeenCalled();
    stop?.();
  });

  it("shares delegated listeners until the final subscriber leaves", () => {
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const stopFirst = observeAutocapture(vi.fn(), {});
    const stopSecond = observeAutocapture(vi.fn(), {});

    expect(registrationCount(addEventListener.mock.calls, "click")).toBe(1);
    expect(registrationCount(addEventListener.mock.calls, "submit")).toBe(1);

    stopFirst?.();
    expect(registrationCount(removeEventListener.mock.calls, "click")).toBe(0);
    expect(registrationCount(removeEventListener.mock.calls, "submit")).toBe(0);

    stopSecond?.();
    expect(registrationCount(removeEventListener.mock.calls, "click")).toBe(1);
    expect(registrationCount(removeEventListener.mock.calls, "submit")).toBe(1);
  });

  it("emits a privacy-bounded action through the normal delivery pipeline", async () => {
    const fetchMock = installFetchMock();
    const addEventListener = vi.spyOn(document, "addEventListener");
    const client = createAppAnalytics();
    const button = annotatedButton("export_clicked");
    button.textContent = "Export victor@example.com";
    button.setAttribute("value", "private-value");

    try {
      client.init({
        endpoint: "/analytics",
        automaticPageViews: false,
        autocapture: true,
      });
      invokeInstalledListener(addEventListener.mock.calls, "click", button);
      await client.flush();

      const record = readFirstLogRecord(
        readPayload(fetchMock.mock.calls[0]?.[1]),
      );
      expect(record.eventName).toBe("export_clicked");
      expect(
        readStringAttribute(record, "databricks.app.analytics.event.type"),
      ).toBe("action");
      expect(
        readStringAttribute(record, "databricks.app.analytics.event.name"),
      ).toBe("export_clicked");

      const payload = JSON.stringify(record);
      expect(payload).not.toContain("victor@example.com");
      expect(payload).not.toContain("private-value");
    } finally {
      await client.shutdown();
    }
  });

  it("is on by default and reports ignored annotations to the client", async () => {
    const diagnostics: AppAnalyticsDiagnostic[] = [];
    const fetchMock = installFetchMock();
    const addEventListener = vi.spyOn(document, "addEventListener");
    const client = createAppAnalytics();
    const decorative = document.createElement("div");
    decorative.dataset.appAnalyticsEvent = "decorative_clicked";
    document.body.append(decorative);

    try {
      client.init({
        automaticPageViews: false,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      invokeInstalledListener(addEventListener.mock.calls, "click", decorative);
      await client.flush();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(diagnostics).toEqual([
        {
          code: "autocapture_ignored",
          eventCount: 1,
          reason: "not_interactive",
        },
      ]);
    } finally {
      await client.shutdown();
    }
  });

  it("installs idempotently and cleans up when disabled", async () => {
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const client = createAppAnalytics();

    try {
      client.init({ automaticPageViews: false, autocapture: true });
      client.init({ automaticPageViews: false, autocapture: true });

      expect(registrationCount(addEventListener.mock.calls, "click")).toBe(1);
      expect(registrationCount(addEventListener.mock.calls, "submit")).toBe(1);

      client.init({ automaticPageViews: false, autocapture: false });
      expect(registrationCount(removeEventListener.mock.calls, "click")).toBe(
        1,
      );
      expect(registrationCount(removeEventListener.mock.calls, "submit")).toBe(
        1,
      );
    } finally {
      await client.shutdown();
    }
  });

  it("caps autocaptured actions per SDK session", async () => {
    const diagnostics: string[] = [];
    const fetchMock = installFetchMock();
    const addEventListener = vi.spyOn(document, "addEventListener");
    const client = createAppAnalytics();
    const button = annotatedButton("repeated_click");

    try {
      client.init({
        endpoint: "/analytics",
        automaticPageViews: false,
        autocapture: true,
        onDiagnostic: ({ code }) => diagnostics.push(code),
      });

      for (
        let index = 0;
        index < MAX_AUTOCAPTURE_EVENTS_PER_SESSION + 5;
        index += 1
      ) {
        invokeInstalledListener(addEventListener.mock.calls, "click", button);
      }
      await client.flush();

      const records = fetchMock.mock.calls.flatMap(([, request]) =>
        readLogRecords(readPayload(request)),
      );
      expect(records).toHaveLength(MAX_AUTOCAPTURE_EVENTS_PER_SESSION);
      expect(diagnostics).toEqual(["autocapture_limit_reached"]);
    } finally {
      await client.shutdown();
    }
  });
});

function annotatedButton(eventName: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.dataset.appAnalyticsEvent = eventName;
  document.body.append(button);
  return button;
}

function invokeInstalledListener(
  calls: Array<[string, EventListenerOrEventListenerObject, unknown?]>,
  type: "click" | "submit",
  target: Element,
): void {
  const registration = calls.find(
    ([registeredType, , options]) =>
      registeredType === type && options === true,
  );
  const listener = registration?.[1];
  if (typeof listener !== "function") {
    throw new Error(`Expected one ${type} autocapture listener`);
  }

  listener({
    button: 0,
    isTrusted: true,
    target,
    type,
  } as unknown as Event);
}

function registrationCount(
  calls: Array<[string, EventListenerOrEventListenerObject, unknown?]>,
  type: "click" | "submit",
): number {
  return calls.filter(
    ([registeredType, , options]) =>
      registeredType === type && options === true,
  ).length;
}
