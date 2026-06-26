import type { AgentToolDefinition } from "shared";
import type { ElementCapability } from "./element-registry";

/** A single JSON-Schema property (derived from `shared` to avoid a direct
 * `json-schema` dependency in this package). */
type SchemaProperty = NonNullable<
  AgentToolDefinition["parameters"]["properties"]
>[string];

/**
 * Canonical action verbs. Flattening the tool catalog by verb (rather than by
 * component instance or type) is the whole point: 12 buttons + 3 inputs still
 * expose just `click` + `set_value`, each targeted by an element `id`. Every
 * appkit-ui component maps its behaviour onto one of these shared verbs, so
 * the same `click` tool drives every clickable element on the page.
 *
 * The `target` parameter (the element id) is injected by the catalog
 * synthesizer as an enum of currently-registered ids; the per-verb `params`
 * below are the *additional* arguments a verb needs.
 *
 * NOTE: no `annotations.effect` is attached. Approval gating keys off the
 * tool's annotations, but here destructiveness depends on the *target*
 * ("delete account" button) not the verb (`click`) — a single `click` tool
 * can't be both safe and destructive. Per-target approval is deferred; until
 * then these verbs run without the gate (matches the PoC route's choice not
 * to render an approval card).
 */
export interface VerbDef {
  description: string;
  /** Extra JSON-Schema properties beyond the injected `target`. */
  params: Record<string, SchemaProperty>;
  /** Names of the extra params that are required. */
  required: string[];
}

export const VERB_DEFS: Record<string, VerbDef> = {
  click: {
    description:
      "Click an interactive element (button, etc.) identified by its target id.",
    params: {},
    required: [],
  },
  set_value: {
    description:
      "Set the text value of an input or textarea identified by its target id.",
    params: {
      value: { type: "string", description: "The new value to set." },
    },
    required: ["value"],
  },
  clear: {
    description: "Clear the text value of an input or textarea.",
    params: {},
    required: [],
  },
  focus: {
    description: "Move keyboard focus to an element (e.g. an input).",
    params: {},
    required: [],
  },
  toggle: {
    description:
      "Toggle a checkbox, switch, or toggle button on/off, identified by its target id.",
    params: {},
    required: [],
  },
  select: {
    description:
      "Select/activate an option, tab, radio button, or menu item by its target id (e.g. switch tabs or pick a radio option).",
    params: {},
    required: [],
  },
  choose: {
    description:
      "Choose an option by name from a dropdown/select identified by its target id. Opens it, picks the matching option, and closes it.",
    params: {
      option: {
        type: "string",
        description: "The visible label of the option to choose.",
      },
    },
    required: ["option"],
  },
  open: {
    description:
      "Open a disclosure or overlay (dialog, popover, dropdown, accordion section, …) by the target id of its trigger.",
    params: {},
    required: [],
  },
  close: {
    description:
      "Close a disclosure or overlay by the target id of its trigger.",
    params: {},
    required: [],
  },
  read_chart: {
    description:
      "Read a chart's current configuration and underlying data series by its target id. Use to understand what a chart shows before acting on it.",
    params: {},
    required: [],
  },
  highlight_series: {
    description:
      "Visually highlight (emphasize) one data series in a chart by name. Pass the chart's target id and the series name.",
    params: {
      series: {
        type: "string",
        description: "Name of the series/category to highlight.",
      },
    },
    required: ["series"],
  },
};

/** The `ui_snapshot` discovery tool name. Reserved across the catalog. */
export const SNAPSHOT_TOOL = "ui_snapshot";

/** True when `name` is a synthesized UI tool (a verb or the snapshot tool). */
export function isUiToolName(name: string): boolean {
  return name === SNAPSHOT_TOOL || name in VERB_DEFS;
}

/**
 * Element roles core components register as via `useAgentElement`. Each maps
 * to a set of verbs (charts register separately via `useAgentChart`).
 */
export type AgentElementRole =
  | "button"
  | "input"
  | "textarea"
  | "checkbox"
  | "switch"
  | "toggle"
  | "option"
  | "radio"
  | "tab"
  | "menuitem"
  | "disclosure"
  | "overlay"
  | "select";

type ValueNode = HTMLInputElement | HTMLTextAreaElement;

/**
 * Set a controlled React input/textarea's value the way the browser would, so
 * React's change tracking fires. Assigning `.value` directly is swallowed by
 * React's controlled-input machinery; going through the prototype's native
 * setter and resetting React's value tracker is the supported escape hatch.
 */
function setNativeValue(node: ValueNode, value: string): void {
  const previous = node.value;
  const proto =
    node instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) {
    setter.call(node, value);
  } else {
    node.value = value;
  }
  // React tracks the last value it knows about on a hidden `_valueTracker` to
  // decide whether a native `input` event represents a real change. Going
  // through the prototype setter above bypasses React's instance setter, but
  // we still force the tracker back to the *previous* value so React always
  // sees a delta and fires the component's `onChange` — without this a
  // controlled input silently snaps back to its React state value.
  const tracker = (
    node as ValueNode & { _valueTracker?: { setValue(v: string): void } }
  )._valueTracker;
  if (tracker && previous !== value) tracker.setValue(previous);
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Best-effort accessible label for any element. */
export function deriveLabel(node: HTMLElement): string {
  const aria = node.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim();

  const labelledBy = node.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => node.ownerDocument.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }

  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
    if (node.placeholder?.trim()) return node.placeholder.trim();
    if (node.name?.trim()) return node.name.trim();
  }

  const text = node.textContent?.trim();
  if (text) return text;

  const name = node.getAttribute("name");
  return name?.trim() || "";
}

function isChecked(node: HTMLElement): boolean {
  if (node instanceof HTMLInputElement) return node.checked;
  // Radix checkbox/switch render a <button> with aria-checked / data-state.
  return (
    node.getAttribute("aria-checked") === "true" ||
    node.dataset.state === "checked"
  );
}

function isPressed(node: HTMLElement): boolean {
  return (
    node.getAttribute("aria-pressed") === "true" || node.dataset.state === "on"
  );
}

function isSelected(node: HTMLElement): boolean {
  return (
    node.getAttribute("aria-selected") === "true" ||
    node.getAttribute("aria-checked") === "true" ||
    node.dataset.state === "active" ||
    node.dataset.state === "on" ||
    node.dataset.state === "checked"
  );
}

function isExpanded(node: HTMLElement): boolean {
  return (
    node.getAttribute("aria-expanded") === "true" ||
    node.dataset.state === "open"
  );
}

function isDisabled(node: HTMLElement): boolean {
  if ("disabled" in node && typeof node.disabled === "boolean") {
    return node.disabled;
  }
  return (
    node.getAttribute("aria-disabled") === "true" ||
    node.hasAttribute("disabled")
  );
}

function dispatchEscape(node: HTMLElement): void {
  node.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
    }),
  );
}

/**
 * Live state reader for the snapshot, keyed by role. Read lazily at snapshot
 * time so the agent always sees current values.
 */
export function roleState(role: AgentElementRole, node: HTMLElement): unknown {
  const disabled = isDisabled(node);
  switch (role) {
    case "input":
    case "textarea":
      return { value: (node as ValueNode).value, disabled };
    case "checkbox":
    case "switch":
      return { checked: isChecked(node), disabled };
    case "toggle":
      return { pressed: isPressed(node), disabled };
    case "option":
    case "radio":
    case "tab":
    case "menuitem":
      return { selected: isSelected(node), disabled };
    case "disclosure":
    case "overlay":
      return { open: isExpanded(node), disabled };
    case "select":
      return {
        value: node.textContent?.trim() ?? "",
        open: isExpanded(node),
        disabled,
      };
    default:
      return { disabled };
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for React to commit and Radix to update the DOM after a programmatic
 * click. Reading `aria-checked` / `data-state` synchronously after `.click()`
 * returns the *pre-update* value for controlled components, which makes the
 * agent think the action failed and retry (toggling twice). Two animation
 * frames is enough for React to flush the re-render.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    } else {
      setTimeout(resolve, 32);
    }
  });
}

/**
 * Currently-rendered options for an open Radix Select. Options are portaled to
 * the document (not nested under the trigger), and `aria-controls` on the
 * trigger points at the listbox, so prefer that and fall back to a
 * document-wide query (only one select is open at a time).
 */
function selectOptions(trigger: HTMLElement): HTMLElement[] {
  const doc = trigger.ownerDocument;
  const id = trigger.getAttribute("aria-controls");
  const root: ParentNode = (id && doc.getElementById(id)) || doc;
  return Array.from(root.querySelectorAll<HTMLElement>('[role="option"]'));
}

/**
 * Open a Radix Select, click the option whose visible label matches `option`
 * (exact, then substring, case-insensitive), and let Radix close it. Throws
 * with the available labels when nothing matches so the agent can self-correct.
 */
async function chooseSelectOption(
  trigger: HTMLElement,
  option: string,
): Promise<{ selected: string }> {
  if (!isExpanded(trigger)) trigger.click();
  let options: HTMLElement[] = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    await delay(25);
    options = selectOptions(trigger);
    if (options.length > 0) break;
  }
  const want = option.trim().toLowerCase();
  const label = (el: HTMLElement) => (el.textContent ?? "").trim();
  const match =
    options.find((o) => label(o).toLowerCase() === want) ??
    options.find((o) => label(o).toLowerCase().includes(want));
  if (!match) {
    dispatchEscape(trigger);
    const available = options.map(label).filter(Boolean).join(", ");
    throw new Error(
      `Option "${option}" not found. Available options: ${available || "(none)"}.`,
    );
  }
  match.click();
  return { selected: label(match) || option };
}

/**
 * Build the verb → capability map for a role. The handlers act on the live DOM
 * node (clicking, setting value via the native setter, dispatching Escape) so
 * they work for both controlled and uncontrolled components without the
 * component exposing its internal state.
 */
export function buildRoleCapabilities(
  role: AgentElementRole,
  getNode: () => HTMLElement | null,
): Record<string, ElementCapability> {
  const need = (): HTMLElement => {
    const node = getNode();
    if (!node) throw new Error("Element is no longer mounted.");
    return node;
  };
  const clickCap: ElementCapability = {
    execute: () => {
      need().click();
      return { ok: true };
    },
  };

  switch (role) {
    case "button":
      return { click: clickCap };
    case "input":
    case "textarea":
      return {
        set_value: {
          execute: (args) => {
            const node = need() as ValueNode;
            // Focus first, mirroring real typing — some controlled inputs and
            // form libraries (react-hook-form, etc.) only register a change on
            // a focused field.
            node.focus();
            setNativeValue(node, String(args.value ?? ""));
            return { value: node.value };
          },
        },
        clear: {
          execute: () => {
            const node = need() as ValueNode;
            setNativeValue(node, "");
            return { value: "" };
          },
        },
        focus: {
          execute: () => {
            need().focus();
            return { ok: true };
          },
        },
      };
    case "checkbox":
    case "switch":
      return {
        toggle: {
          execute: async () => {
            const node = need();
            node.click();
            // Read state only after React commits — a controlled component
            // hasn't updated `aria-checked` synchronously, and returning the
            // stale value makes the agent toggle again.
            await nextFrame();
            return { checked: isChecked(node) };
          },
        },
      };
    case "toggle":
      return {
        toggle: {
          execute: async () => {
            const node = need();
            node.click();
            await nextFrame();
            return { pressed: isPressed(node) };
          },
        },
      };
    case "option":
    case "radio":
    case "tab":
    case "menuitem":
      // Selecting = activating the item. Each item is its own registered
      // element, so the agent targets it directly by id instead of the
      // synthesizer guessing DOM structure inside a parent group.
      //
      // `focus()` before `click()` matters for Radix Tabs, which use
      // automatic activation (activate on focus, not on a bare `.click()`).
      return {
        select: {
          execute: async () => {
            const node = need();
            node.focus();
            node.click();
            await nextFrame();
            return { selected: isSelected(node) };
          },
        },
      };
    case "disclosure":
      // Accordion/collapsible: clicking the trigger toggles, so open/close
      // click only when the desired direction differs from the current state.
      return {
        open: {
          execute: async () => {
            const node = need();
            if (!isExpanded(node)) node.click();
            await nextFrame();
            return { open: isExpanded(node) };
          },
        },
        close: {
          execute: async () => {
            const node = need();
            if (isExpanded(node)) node.click();
            await nextFrame();
            return { open: isExpanded(node) };
          },
        },
        toggle: {
          execute: async () => {
            const node = need();
            node.click();
            await nextFrame();
            return { open: isExpanded(node) };
          },
        },
      };
    case "overlay":
      // Dialog/popover/dropdown/sheet: the trigger opens but does not close
      // (clicking it again re-opens). Escape is Radix's universal close.
      return {
        open: {
          execute: async () => {
            const node = need();
            if (!isExpanded(node)) node.click();
            await nextFrame();
            return { open: isExpanded(node) };
          },
        },
        close: {
          execute: async () => {
            const node = need();
            if (isExpanded(node)) dispatchEscape(node);
            await nextFrame();
            return { open: isExpanded(node) };
          },
        },
      };
    case "select":
      // Dropdown: `choose` opens, clicks the matching option, and closes in one
      // call — options are portaled and only exist while open, so a single
      // self-contained handler is more reliable than registering each option.
      return {
        choose: {
          execute: (args) =>
            chooseSelectOption(need(), String(args.option ?? "")),
        },
        open: {
          execute: () => {
            const node = need();
            if (!isExpanded(node)) node.click();
            return { open: isExpanded(node) };
          },
        },
        close: {
          execute: () => {
            const node = need();
            if (isExpanded(node)) dispatchEscape(node);
            return { open: false };
          },
        },
      };
    default:
      return {};
  }
}

/** Slugify an accessible label into a stable, agent-legible id base. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
