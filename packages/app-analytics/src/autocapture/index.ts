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

export interface AutocaptureInteraction {
  readonly eventName: string;
  readonly type: "click" | "submit";
  readonly element: string;
}

type AutocaptureListener = (interaction: AutocaptureInteraction) => void;

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
  subscriptions: Map<unknown, AutocaptureSubscription>;
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
  let interaction: AutocaptureInteraction | undefined;
  try {
    interaction = readInteraction(event);
  } catch {
    return;
  }
  if (interaction === undefined) return;

  for (const subscription of [...state.subscriptions.values()]) {
    try {
      if (subscription.isTrusted(event)) {
        subscription.listener(interaction);
      }
    } catch {
      // Interaction instrumentation must not affect application behavior.
    }
  }
}

function readInteraction(event: Event): AutocaptureInteraction | undefined {
  const target = event.target;
  if (!(target instanceof Element)) return undefined;
  if (target.closest(`[${IGNORE_ATTRIBUTE}]`) !== null) return undefined;

  const annotated = target.closest(`[${EVENT_ATTRIBUTE}]`);
  if (annotated === null || isDisabled(annotated)) return undefined;

  const eventName = annotated.getAttribute(EVENT_ATTRIBUTE);
  if (eventName === null) return undefined;

  if (event.type === "click") {
    if (!annotated.matches(CLICKABLE_SELECTOR) || isNonPrimaryClick(event)) {
      return undefined;
    }
    return { eventName, type: "click", element: annotated.localName };
  }

  if (event.type === "submit" && annotated.localName === "form") {
    return { eventName, type: "submit", element: "form" };
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
  const registry = getRegistry();
  const existing = registry[AUTOCAPTURE_STATE_KEY];
  if (isAutocaptureState(existing)) return existing;

  const state: AutocaptureState = {
    hooks: undefined,
    subscriptions: new Map(),
  };
  registry[AUTOCAPTURE_STATE_KEY] = state;
  return state;
}

function releaseState(state: AutocaptureState): void {
  if (state.subscriptions.size > 0) return;

  const hooks = state.hooks;
  state.hooks = undefined;
  if (hooks !== undefined) {
    safelyRemoveListener(hooks.document, "click", hooks.clickListener);
    safelyRemoveListener(hooks.document, "submit", hooks.submitListener);
  }

  const registry = getRegistry();
  if (registry[AUTOCAPTURE_STATE_KEY] === state) {
    Reflect.deleteProperty(registry, AUTOCAPTURE_STATE_KEY);
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

function getRegistry(): Record<symbol, unknown> {
  return globalThis as unknown as Record<symbol, unknown>;
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
