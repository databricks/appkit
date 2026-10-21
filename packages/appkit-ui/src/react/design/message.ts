import type { DesignElementInfo } from "./inspect";

/** `type` of the message the design canvas posts to an embedding app builder. */
export const DESIGN_SELECTION_MESSAGE = "appkit:design-selection";

/** One selected element in a {@link DesignSelectionMessage}. */
export interface DesignSelectionMessageElement extends DesignElementInfo {
  /** JPEG data URL of the element, when it could be captured. */
  screenshot?: string;
  /** Absolute URL of the same image, served by the app's dev server. */
  screenshotUrl?: string;
}

/**
 * Posted with `window.postMessage` to the app builder that embeds the app
 * (`window.parent`, else `window.opener`) each time the user sends a
 * selection from `/design`. Only posted to the `builderOrigin`s configured on
 * the `design()` plugin.
 *
 * Bump `version` on any incompatible change to this shape.
 */
export interface DesignSelectionMessage {
  type: typeof DESIGN_SELECTION_MESSAGE;
  version: 1;
  /** Id of the selection in `.appkit/design-selection.json`. */
  id?: string;
  /** Page the elements were picked on. */
  url: string;
  note?: string;
  selections: DesignSelectionMessageElement[];
}

/** The window embedding this one: the iframe parent, else the opener. */
function builderWindow(): Window | null {
  if (window.parent !== window) return window.parent;
  return window.opener as Window | null;
}

/**
 * Posts the message to the embedding window once per allowed origin. The
 * browser drops it for any origin the window isn't on, so it never reaches an
 * unexpected page. Returns whether there was a window and an origin to post to.
 */
export function postDesignSelection(
  message: DesignSelectionMessage,
  builderOrigins: string[],
): boolean {
  const target = builderWindow();
  if (!target || builderOrigins.length === 0) return false;
  for (const origin of builderOrigins) target.postMessage(message, origin);
  return true;
}
