import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appAnalytics } from "../index";
import { AppAnalytics } from "../react";
import {
  installFetchMock,
  readFirstLogRecord,
  readPayload,
  readStringAttribute,
} from "./test-utils";

afterEach(async () => {
  await appAnalytics.shutdown();
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AppAnalytics", () => {
  it("tracks one initial page in Strict Mode", async () => {
    const fetchMock = installFetchMock();
    const init = vi.spyOn(appAnalytics, "init");
    const shutdown = vi.spyOn(appAnalytics, "shutdown");

    const view = render(
      <StrictMode>
        <AppAnalytics endpoint="/analytics" />
      </StrictMode>,
    );
    await appAnalytics.flush();
    view.unmount();

    expect(init).toHaveBeenCalledWith({ endpoint: "/analytics" });
    expect(shutdown).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const record = readFirstLogRecord(
      readPayload(fetchMock.mock.calls[0]?.[1]),
    );
    expect(record.eventName).toBe("page_view");
    expect(
      readStringAttribute(record, "databricks.app.analytics.event.type"),
    ).toBe("page_view");
  });

  it("can disable automatic page views", async () => {
    const fetchMock = installFetchMock();
    const init = vi.spyOn(appAnalytics, "init");

    const view = render(
      <AppAnalytics endpoint="/analytics" automaticPageViews={false} />,
    );
    await appAnalytics.flush();
    view.unmount();

    expect(init).toHaveBeenCalledWith({
      endpoint: "/analytics",
      automaticPageViews: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes sampling and delivery hooks to the shared client", () => {
    const beforeSend = vi.fn(() => true);
    const onDiagnostic = vi.fn();
    const init = vi.spyOn(appAnalytics, "init");

    const view = render(
      <AppAnalytics
        autocapture
        endpoint="/analytics"
        automaticPageViews={false}
        webVitals
        sampleRate={0.25}
        beforeSend={beforeSend}
        onDiagnostic={onDiagnostic}
      />,
    );
    view.unmount();

    expect(init).toHaveBeenCalledWith({
      autocapture: true,
      endpoint: "/analytics",
      automaticPageViews: false,
      webVitals: true,
      sampleRate: 0.25,
      beforeSend,
      onDiagnostic,
    });
  });
});
