type NavigationListener = () => void;
type HistoryMethodName = "pushState" | "replaceState";

interface NavigationHooks {
  originalPushState: History["pushState"];
  originalReplaceState: History["replaceState"];
  popstateListener: () => void;
  pushStateDescriptor: PropertyDescriptor | undefined;
  replaceStateDescriptor: PropertyDescriptor | undefined;
  wrappedPushState: History["pushState"];
  wrappedReplaceState: History["replaceState"];
}

interface NavigationState {
  hooks: NavigationHooks | undefined;
  listeners: Set<NavigationListener>;
}

const NAVIGATION_STATE_KEY = Symbol.for(
  "@databricks/app-analytics/navigation-state",
);

export function observePageChanges(
  listener: NavigationListener,
): (() => void) | undefined {
  if (typeof window === "undefined") return undefined;

  const state = getNavigationState();
  if (state.hooks === undefined && !installNavigationHooks(state)) {
    releaseNavigationState(state);
    return undefined;
  }

  state.listeners.add(listener);
  let subscribed = true;

  return () => {
    if (!subscribed) return;
    subscribed = false;
    state.listeners.delete(listener);
    releaseNavigationState(state);
  };
}

function getNavigationState(): NavigationState {
  const registry = getNavigationRegistry();
  const existing = registry[NAVIGATION_STATE_KEY];
  if (isNavigationState(existing)) return existing;

  const state: NavigationState = {
    hooks: undefined,
    listeners: new Set(),
  };
  registry[NAVIGATION_STATE_KEY] = state;
  return state;
}

function installNavigationHooks(state: NavigationState): boolean {
  const history = window.history;
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  const pushStateDescriptor = Object.getOwnPropertyDescriptor(
    history,
    "pushState",
  );
  const replaceStateDescriptor = Object.getOwnPropertyDescriptor(
    history,
    "replaceState",
  );
  const wrappedPushState: History["pushState"] = function (
    this: History,
    ...args: Parameters<History["pushState"]>
  ): void {
    originalPushState.apply(this, args);
    notifyNavigation(state);
  };
  const wrappedReplaceState: History["replaceState"] = function (
    this: History,
    ...args: Parameters<History["replaceState"]>
  ): void {
    originalReplaceState.apply(this, args);
    notifyNavigation(state);
  };
  const popstateListener = () => notifyNavigation(state);

  let pushStateInstalled = false;
  let replaceStateInstalled = false;
  let popstateInstalled = false;

  try {
    history.pushState = wrappedPushState;
    pushStateInstalled = history.pushState === wrappedPushState;
    if (!pushStateInstalled) return false;

    history.replaceState = wrappedReplaceState;
    replaceStateInstalled = history.replaceState === wrappedReplaceState;
    if (!replaceStateInstalled) return false;

    window.addEventListener("popstate", popstateListener);
    popstateInstalled = true;

    state.hooks = {
      originalPushState,
      originalReplaceState,
      popstateListener,
      pushStateDescriptor,
      replaceStateDescriptor,
      wrappedPushState,
      wrappedReplaceState,
    };
    return true;
  } catch {
    return false;
  } finally {
    if (state.hooks === undefined) {
      if (popstateInstalled) {
        safelyRemovePopstateListener(popstateListener);
      }
      if (replaceStateInstalled) {
        restoreHistoryMethod(
          "replaceState",
          wrappedReplaceState,
          replaceStateDescriptor,
        );
      }
      if (pushStateInstalled) {
        restoreHistoryMethod(
          "pushState",
          wrappedPushState,
          pushStateDescriptor,
        );
      }
    }
  }
}

function releaseNavigationState(state: NavigationState): void {
  if (state.listeners.size > 0) return;

  uninstallNavigationHooks(state);
  const registry = getNavigationRegistry();
  if (registry[NAVIGATION_STATE_KEY] === state) {
    Reflect.deleteProperty(registry, NAVIGATION_STATE_KEY);
  }
}

function uninstallNavigationHooks(state: NavigationState): void {
  const hooks = state.hooks;
  if (hooks === undefined) return;

  state.hooks = undefined;
  safelyRemovePopstateListener(hooks.popstateListener);
  restoreHistoryMethod(
    "replaceState",
    hooks.wrappedReplaceState,
    hooks.replaceStateDescriptor,
  );
  restoreHistoryMethod(
    "pushState",
    hooks.wrappedPushState,
    hooks.pushStateDescriptor,
  );
}

function restoreHistoryMethod(
  name: HistoryMethodName,
  installedMethod: History[HistoryMethodName],
  originalDescriptor: PropertyDescriptor | undefined,
): void {
  const history = window.history;
  if (history[name] !== installedMethod) return;

  try {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(history, name);
    } else {
      Object.defineProperty(history, name, originalDescriptor);
    }
  } catch {
    // A host may lock History after the SDK installs its hooks.
  }
}

function safelyRemovePopstateListener(listener: () => void): void {
  try {
    window.removeEventListener("popstate", listener);
  } catch {
    // Navigation instrumentation must not affect host cleanup.
  }
}

function notifyNavigation(state: NavigationState): void {
  for (const listener of [...state.listeners]) {
    try {
      listener();
    } catch {
      // Navigation APIs must preserve host behavior when instrumentation fails.
    }
  }
}

function getNavigationRegistry(): Record<symbol, unknown> {
  return globalThis as unknown as Record<symbol, unknown>;
}

function isNavigationState(value: unknown): value is NavigationState {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<NavigationState>;
  return (
    candidate.listeners instanceof Set &&
    (candidate.hooks === undefined || isNavigationHooks(candidate.hooks))
  );
}

function isNavigationHooks(value: unknown): value is NavigationHooks {
  if (typeof value !== "object" || value === null) return false;

  const hooks = value as Partial<NavigationHooks>;
  return (
    typeof hooks.originalPushState === "function" &&
    typeof hooks.originalReplaceState === "function" &&
    typeof hooks.popstateListener === "function" &&
    typeof hooks.wrappedPushState === "function" &&
    typeof hooks.wrappedReplaceState === "function"
  );
}
