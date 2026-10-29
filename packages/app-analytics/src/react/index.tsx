"use client";

import { useEffect, useRef } from "react";

import {
  appAnalytics,
  type AppAnalyticsEvent,
  type AppAnalyticsOptions,
} from "../index";

export type AppAnalyticsProps = AppAnalyticsOptions;

/**
 * Configures the default App Analytics client from props. Mount it once at
 * the application root.
 *
 * Props merge into the client's configuration like `init()` options: an
 * omitted prop keeps the current value, so the component does not undo
 * configuration made elsewhere. `beforeSend` and `onDiagnostic` may be
 * inline functions; the latest ones are called without reconfiguring the
 * client on every render. Unmounting does not shut the client down, because
 * code outside React may use it.
 */
export function AppAnalytics({
  autocapture,
  automaticPageViews,
  beforeSend,
  endpoint,
  onDiagnostic,
  sampleRate,
  webVitals,
}: AppAnalyticsProps): null {
  // Declared before the init effect so the first init already sees them.
  const callbacks = useRef({ beforeSend, onDiagnostic });
  useEffect(() => {
    callbacks.current = { beforeSend, onDiagnostic };
  });

  const hasBeforeSend = beforeSend !== undefined;
  const hasOnDiagnostic = onDiagnostic !== undefined;

  useEffect(() => {
    appAnalytics.init({
      autocapture,
      automaticPageViews,
      endpoint,
      sampleRate,
      webVitals,
      beforeSend: hasBeforeSend
        ? (event: AppAnalyticsEvent) => callbacks.current.beforeSend?.(event)
        : undefined,
      onDiagnostic: hasOnDiagnostic
        ? (diagnostic) => callbacks.current.onDiagnostic?.(diagnostic)
        : undefined,
    });
  }, [
    autocapture,
    automaticPageViews,
    endpoint,
    hasBeforeSend,
    hasOnDiagnostic,
    sampleRate,
    webVitals,
  ]);

  return null;
}
