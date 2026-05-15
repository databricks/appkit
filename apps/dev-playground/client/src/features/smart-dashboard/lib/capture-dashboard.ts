import html2canvas from "html2canvas-pro";

/**
 * Captures an element to a compressed JPEG data URL.
 *
 * We deliberately use JPEG + downscale instead of PNG because:
 *
 * - AppKit's server plugin applies `express.json({ limit: default = 100kb })`
 *   globally. A full-fidelity dashboard PNG encoded in base64 is typically
 *   200-600kb — over the limit.
 * - JPEG @ quality 0.85 + pixelRatio 1 keeps payloads to ~40-80kb base64
 *   for the Smart Dashboard viewport, comfortably under the limit.
 *
 * If the payload ever needs to grow (higher fidelity, larger viewports),
 * switch to a raw body route (`express.raw`) with an explicit larger limit.
 *
 * `html2canvas-pro` (drop-in fork of html2canvas) is required because
 * Tailwind v4 emits `oklch()` colors throughout the computed styles of
 * every node, which the original html2canvas 1.x cannot parse.
 */
export async function captureDashboardAsDataUrl(
  el: HTMLElement,
  opts: { quality?: number; scale?: number } = {},
): Promise<{ dataUrl: string; widthPx: number; heightPx: number }> {
  const quality = opts.quality ?? 0.85;
  const scale = opts.scale ?? 1;
  const backgroundColor = readCssVar(el, "--background") ?? "#ffffff";

  const canvas = await html2canvas(el, {
    backgroundColor,
    scale,
    useCORS: true,
    allowTaint: false,
    logging: false,
  });

  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  return { dataUrl, widthPx: canvas.width, heightPx: canvas.height };
}

function readCssVar(el: HTMLElement, name: string): string | null {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  if (!raw) return null;
  // CSS var values may be raw HSL triplets ("0 0% 100%") or full hsl(...).
  // Wrap naked triplets so html2canvas' painter treats them as colors.
  if (/^\d/.test(raw)) return `hsl(${raw})`;
  return raw;
}
