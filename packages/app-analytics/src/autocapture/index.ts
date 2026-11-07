import {
  deleteGlobal,
  getOrCreateGlobal,
  readGlobal,
} from "../core/global-registry";

export const MAX_AUTOCAPTURE_EVENTS_PER_SESSION = 100;

const EVENT_ATTRIBUTE = "data-app-analytics-event";
const IGNORE_ATTRIBUTE = "data-app-analytics-ignore";
const AUTOCAPTURE_STATE_KEY = Symbol.for(
  "@databricks/app-analytics/autocapture-state",
);

const CLICKABLE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "summary",
  "textarea",
  "[role='button']",
  "[role='checkbox']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='switch']",
  "[role='tab']",
].join(",");

/**
 * What an annotated element produced: an Action name, or an annotation that
 * cannot fire because it is not on an interactive element (clicks) or a form
 * (submits). An ignored annotation is reported once per element.
 */
export type AutocaptureSignal =
  | { readonly kind: "interaction"; readonly eventName: string }
  | { readonly kind: "ignored"; readonly reason: "not_interactive" };

type AutocaptureListener = (signal: AutocaptureSignal) => void;

interface AutocaptureSubscription {
  isTrusted: (event: Event) => boolean;
  listener: AutocaptureListener;
}

interface AutocaptureHooks {
  clickListener: EventListener;
  document: Document;
  submitListener: EventListener;
}

interface AutocaptureState {
  hooks: AutocaptureHooks | undefined;
  /** Annotated elements already reported as ignored. */
  ignoredElements?: WeakSet<Element>;
  subscriptions: Map<unknown, AutocaptureSubscription>;
}

interface ReadSignal {
  readonly annotated: Element;
  readonly signal: AutocaptureSignal;
}

interface AutocaptureObserverOptions {
  /** Test seam; production always relies on Event.isTrusted. */
  isTrusted?: (event: Event) => boolean;
}

/**
 * Shares one pair of delegated listeners across SDK clients and module reloads.
 * Only explicitly annotated interactive elements produce an interaction.
 */
export function observeAutocapture(
  listener: AutocaptureListener,
  subscriberKey: unknown = listener,
  options: AutocaptureObserverOptions = {},
): (() => void) | undefined {
  if (typeof document === "undefined") return undefined;

  const state = getAutocaptureState();
  state.subscriptions.set(subscriberKey, {
    listener,
    isTrusted: options.isTrusted ?? ((event) => event.isTrusted),
  });

  if (state.hooks === undefined && !installHooks(state, document)) {
    state.subscriptions.delete(subscriberKey);
    releaseState(state);
    return undefined;
  }

  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;

    if (state.subscriptions.get(subscriberKey)?.listener === listener) {
      state.subscriptions.delete(subscriberKey);
    }
    releaseState(state);
  };
}

function installHooks(state: AutocaptureState, target: Document): boolean {
  const clickListener: EventListener = (event) => notify(state, event);
  const submitListener: EventListener = (event) => notify(state, event);
  let clickInstalled = false;
  let submitInstalled = false;

  try {
    target.addEventListener("click", clickListener, true);
    clickInstalled = true;
    target.addEventListener("submit", submitListener, true);
    submitInstalled = true;
    state.hooks = { clickListener, document: target, submitListener };
    return true;
  } catch {
    return false;
  } finally {
    if (state.hooks === undefined) {
      if (submitInstalled) {
        safelyRemoveListener(target, "submit", submitListener);
      }
      if (clickInstalled) {
        safelyRemoveListener(target, "click", clickListener);
      }
    }
  }
}

function notify(state: AutocaptureState, event: Event): void {
  let read: ReadSignal | undefined;
  try {
    read = readSignal(event);
  } catch {
    return;
  }
  if (read === undefined) return;

  const trusted = [...state.subscriptions.values()].filter((subscription) =>
    safelyIsTrusted(subscription, event),
  );
  if (trusted.length === 0) return;

  if (read.signal.kind === "ignored") {
    state.ignoredElements ??= new WeakSet();
    if (state.ignoredElements.has(read.annotated)) return;
    state.ignoredElements.add(read.annotated);
  }

  for (const subscription of trusted) {
    try {
      subscription.listener(read.signal);
    } catch {
      // Interaction instrumentation must not affect application behavior.
    }
  }
}

function safelyIsTrusted(
  subscription: AutocaptureSubscription,
  event: Event,
): boolean {
  try {
    return subscription.isTrusted(event);
  } catch {
    return false;
  }
}

function readSignal(event: Event): ReadSignal | undefined {
  const target = event.target;
  if (!(target instanceof Element)) return undefined;
  if (target.closest(`[${IGNORE_ATTRIBUTE}]`) !== null) return undefined;

  const annotated = target.closest(`[${EVENT_ATTRIBUTE}]`);
  if (annotated === null || isDisabled(annotated)) return undefined;

  const eventName = annotated.getAttribute(EVENT_ATTRIBUTE);
  if (eventName === null) return undefined;

  if (event.type === "click") {
    if (isNonPrimaryClick(event)) return undefined;
    return {
      annotated,
      signal: annotated.matches(CLICKABLE_SELECTOR)
        ? { kind: "interaction", eventName }
        : { kind: "ignored", reason: "not_interactive" },
    };
  }

  if (event.type === "submit") {
    return {
      annotated,
      signal:
        annotated.localName === "form"
          ? { kind: "interaction", eventName }
          : { kind: "ignored", reason: "not_interactive" },
    };
  }

  return undefined;
}

function isDisabled(element: Element): boolean {
  return (
    element.getAttribute("aria-disabled")?.toLowerCase() === "true" ||
    element.matches(":disabled")
  );
}

function isNonPrimaryClick(event: Event): boolean {
  return "button" in event && event.button !== 0;
}

function getAutocaptureState(): AutocaptureState {
  return getOrCreateGlobal(AUTOCAPTURE_STATE_KEY, isAutocaptureState, () => ({
    hooks: undefined,
    subscriptions: new Map(),
  }));
}

function releaseState(state: AutocaptureState): void {
  if (state.subscriptions.size > 0) return;

  const hooks = state.hooks;
  state.hooks = undefined;
  if (hooks !== undefined) {
    safelyRemoveListener(hooks.document, "click", hooks.clickListener);
    safelyRemoveListener(hooks.document, "submit", hooks.submitListener);
  }

  if (readGlobal(AUTOCAPTURE_STATE_KEY) === state) {
    deleteGlobal(AUTOCAPTURE_STATE_KEY);
  }
}

function safelyRemoveListener(
  target: Document,
  type: "click" | "submit",
  listener: EventListener,
): void {
  try {
    target.removeEventListener(type, listener, true);
  } catch {
    // Host cleanup errors must not escape into the application.
  }
}

function isAutocaptureState(value: unknown): value is AutocaptureState {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<AutocaptureState>;
  return (
    candidate.subscriptions instanceof Map &&
    (candidate.hooks === undefined || isAutocaptureHooks(candidate.hooks))
  );
}

function isAutocaptureHooks(value: unknown): value is AutocaptureHooks {
  if (typeof value !== "object" || value === null) return false;

  const hooks = value as Partial<AutocaptureHooks>;
  return (
    typeof hooks.clickListener === "function" &&
    typeof hooks.submitListener === "function" &&
    typeof hooks.document === "object" &&
    hooks.document !== null
  );
}
