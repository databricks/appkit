// Dev-only design canvas + element picker, served by the `design` plugin
// (beta, '@databricks/appkit/beta') at /design. Kept off '/react/beta' so apps
// that never open the canvas don't pay for it.
export { DesignCanvas, type DesignCanvasProps } from "./design-canvas";
export { DesignPicker, type DesignPickerProps } from "./design-picker";
export type { DesignElementInfo } from "./inspect";
export {
  DESIGN_SELECTION_MESSAGE,
  type DesignSelectionMessage,
  type DesignSelectionMessageElement,
} from "./message";
