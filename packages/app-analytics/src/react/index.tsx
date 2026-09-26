"use client";

import { useEffect } from "react";

import { appAnalytics, type AppAnalyticsOptions } from "../index";

export type AppAnalyticsProps = AppAnalyticsOptions;

/** Initializes the default App Analytics client for a React application. */
export function AppAnalytics({
  autocapture,
  endpoint,
  automaticPageViews,
  beforeSend,
  onDiagnostic,
  sampleRate,
  webVitals,
}: AppAnalyticsProps): null {
  useEffect(() => {
    const options: AppAnalyticsOptions = {};
    if (autocapture !== undefined) options.autocapture = autocapture;
    if (endpoint !== undefined) options.endpoint = endpoint;
    if (automaticPageViews !== undefined) {
      options.automaticPageViews = automaticPageViews;
    }
    if (beforeSend !== undefined) options.beforeSend = beforeSend;
    if (onDiagnostic !== undefined) options.onDiagnostic = onDiagnostic;
    if (sampleRate !== undefined) options.sampleRate = sampleRate;
    if (webVitals !== undefined) options.webVitals = webVitals;
    appAnalytics.init(options);
    // This component configures the shared singleton but does not own it.
    // Applications may use the same client outside React and shut it down there.
  }, [
    autocapture,
    automaticPageViews,
    beforeSend,
    endpoint,
    onDiagnostic,
    sampleRate,
    webVitals,
  ]);

  return null;
}
