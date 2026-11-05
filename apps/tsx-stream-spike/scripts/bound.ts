// Renderer-independent bound: for each recorded draft, the earliest moment (in the
// replay's 100 ms batches, after the draft's first chunk) any renderer could paint
// something of the page: its renderable cut has the page component's `return (`.
// Nothing the page component renders exists before that. Shown for any-line cuts and
// for component-boundary cuts (complete top-level declarations only).
//   node scripts/bound.ts
import { readdirSync, readFileSync } from "node:fs";

import { transformWithOxc } from "vite";

import { renderablePartial } from "../../../packages/appkit/src/plugins/design/stream.ts";

const parses = async (code: string) => {
  try {
    await transformWithOxc(code, "draft.tsx", { lang: "tsx" });
    return true;
  } catch {
    return false;
  }
};
const returnsJsx = (code: string) =>
  /\breturn\s*\(?\s*</.test(code.slice(code.indexOf("export default")));

const BATCH_MS = 100;
for (const file of readdirSync("drafts/recordings").sort()) {
  const rec = JSON.parse(readFileSync(`drafts/recordings/${file}`, "utf8"));
  for (const [name, s] of Object.entries<{ chunks: [number, string][] }>(
    rec.streams,
  )) {
    if (name === "mock.ts") continue;
    const first = s.chunks[0][0];
    const last = s.chunks[s.chunks.length - 1][0] - first;
    const at: Record<"any" | "boundary", number | null> = {
      any: null,
      boundary: null,
    };
    let text = "";
    let next = 0;
    for (let t = first; next < s.chunks.length; t += BATCH_MS) {
      while (next < s.chunks.length && s.chunks[next][0] <= t)
        text += s.chunks[next++][1];
      for (const mode of ["any", "boundary"] as const) {
        if (at[mode] !== null) continue;
        const code = await renderablePartial(text, parses, {
          boundary: mode === "boundary",
        });
        if (code && returnsJsx(code)) at[mode] = t - first;
      }
      if (at.any !== null && at.boundary !== null) break;
    }
    // Null: not before the finished file (the component closes on the last line).
    const sec = (ms: number | null) =>
      ms === null ? "final file" : `${(ms / 1000).toFixed(1)}s`;
    console.log(
      `${name.padEnd(9)} earliest possible paint: any line ${sec(at.any)}, component boundary ${sec(at.boundary)} (last chunk ${sec(last)})`,
    );
  }
}
