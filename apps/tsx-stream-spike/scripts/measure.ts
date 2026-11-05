// Replays recordings in /design/__replay, records a video, and compares each streamed
// page's final render with the compiled page at /design/<name>.
//   node scripts/measure.ts --app taxi --out <dir>
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "@playwright/test";

const { values: a } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8040" },
    app: { type: "string", default: "taxi" },
    out: { type: "string" },
    theme: { type: "string", default: "light" },
  },
});
const out = path.resolve(a.out ?? "measure-out");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({
  viewport: { width: 1340, height: 520 },
  recordVideo: { dir: out, size: { width: 1340, height: 520 } },
  colorScheme: a.theme === "dark" ? "dark" : "light",
});
const page = await ctx.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${a.url}/replay.html?autostart&app=${a.app}`);
// Grid screenshots once a second, to look for broken frames by eye.
let n = 0;
const shots = setInterval(() => {
  void page
    .screenshot({
      path: path.join(out, `grid-${String(n++).padStart(3, "0")}.png`),
    })
    .catch(() => {});
}, 1000);
await page.waitForFunction(
  () => (window as { __replayDone?: boolean }).__replayDone,
  null,
  { timeout: 300_000 },
);
clearInterval(shots);
const results = await page.evaluate(
  () =>
    (window as unknown as { __replayResults: Record<string, unknown>[] })
      .__replayResults,
);

const norm = (html: string) =>
  html
    .replace(/_echarts_instance_="[^"]*"/g, "")
    .replace(/ style="(animation-duration: 0s;)?"/g, "")
    .replace(/_r_[a-z0-9]+_/g, "")
    .replace(/size-sensor-id="\d+"/g, "");
for (const r of results) {
  const name = r.page as string;
  const frame = page
    .frames()
    .find((f) => f.url().includes(`/design/__stream/${name}`));
  if (!frame) continue;
  const iframe = page.locator(`iframe[data-page="${name}"]`);
  await iframe.evaluate((el) => {
    el.style.transform = "none";
    (el.parentElement as HTMLElement).style.cssText =
      "width:1280px;height:900px;position:fixed;inset:0;z-index:9";
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(2500);
  const streamed = await iframe.screenshot();
  const streamedHtml = norm(
    await frame.evaluate(
      () => document.getElementById("root")?.innerHTML ?? "",
    ),
  );
  await iframe.evaluate((el) => {
    el.style.transform = "";
    (el.parentElement as HTMLElement).style.position = "static";
  });

  const ref = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    colorScheme: a.theme === "dark" ? "dark" : "light",
  });
  await ref.goto(`${a.url}/design/${name}`);
  await ref.waitForSelector("#root > *");
  await ref.waitForTimeout(2500);
  const compiled = await ref.screenshot();
  const compiledHtml = norm(
    await ref.evaluate(() => document.getElementById("root")?.innerHTML ?? ""),
  );
  await ref.close();
  await writeFile(path.join(out, `${name}-streamed-final.png`), streamed);
  await writeFile(path.join(out, `${name}-compiled.png`), compiled);
  r.domIdentical = streamedHtml === compiledHtml;
  r.pixelsIdentical = streamed.equals(compiled);
  // Differing pixels (any channel off by more than 8), counted in a canvas.
  r.pixelsDiffering = await page.evaluate(
    async ([x, y]) => {
      const load = async (b64: string) =>
        createImageBitmap(
          await (await fetch(`data:image/png;base64,${b64}`)).blob(),
        );
      const [ia, ib] = await Promise.all([load(x), load(y)]);
      const read = (img: ImageBitmap) => {
        const c = new OffscreenCanvas(img.width, img.height).getContext(
          "2d",
        ) as OffscreenCanvasRenderingContext2D;
        c.drawImage(img, 0, 0);
        return c.getImageData(0, 0, img.width, img.height).data;
      };
      const [da, db] = [read(ia), read(ib)];
      let n = 0;
      for (let i = 0; i < da.length; i += 4) {
        if (
          Math.abs(da[i] - db[i]) > 8 ||
          Math.abs(da[i + 1] - db[i + 1]) > 8 ||
          Math.abs(da[i + 2] - db[i + 2]) > 8
        )
          n++;
      }
      return n;
    },
    [streamed.toString("base64"), compiled.toString("base64")],
  );
  if (!r.domIdentical) {
    await writeFile(path.join(out, `${name}-streamed.html`), streamedHtml);
    await writeFile(path.join(out, `${name}-compiled.html`), compiledHtml);
  }
}
await writeFile(
  path.join(out, "results.json"),
  JSON.stringify({ results, errors }, null, 2),
);
console.table(results);
if (errors.length) console.log("page errors:", errors);
await ctx.close();
await browser.close();
