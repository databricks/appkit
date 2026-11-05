// Replays one app's recorded writer streams (mock + drafts a/b/c) through the staging
// files and shows the 3 drafts side by side, each in /design/__stream/<name>, measuring
// per draft: first (meaningful) paint after its first chunk, visible updates, versions
// kept back because they threw, broken frames, and watch/publish latency.
// ?app=taxi picks the recording, ?autostart starts at once; results go to
// window.__replayResults for scripts/measure.ts.

type Recording = {
  app: string;
  streams: Record<
    string,
    { chunks: [number, string][]; final: string; finalAt: number }
  >;
};
type Result = {
  page: string;
  firstChunk: number;
  firstPaint: number | null;
  meaningfulPaint: number | null;
  frames: number;
  kept: number;
  broken: number[];
  watchMs: number[];
  publishMs: number[];
  // Staging write to painted frame, per visible update while streaming.
  paintMs: number[];
  lastWritten?: number;
  finalAt: number;
  [key: string]: unknown;
};

// A first meaningful paint shows a real part of the page, not just a title.
const MEANINGFUL = { chars: 80, height: 300 };
const SCALE = 0.32;
const WIDTH = 1280;
const HEIGHT = 900;

const params = new URLSearchParams(location.search);
document.body.style.cssText =
  "margin:0;font:13px system-ui;background:#f4f4f5;color:#18181b";
const bar = document.createElement("div");
bar.style.cssText = "padding:8px 12px;display:flex;gap:12px;align-items:center";
const select = document.createElement("select");
for (const app of (await (
  await fetch("/__spike/recordings")
).json()) as string[]) {
  select.append(new Option(app, app, false, app === params.get("app")));
}
const button = document.createElement("button");
button.textContent = "Replay";
const clock = document.createElement("span");
bar.append(select, button, clock);
const grid = document.createElement("div");
grid.style.cssText = "display:flex;gap:12px;padding:0 12px";
document.body.append(bar, grid);

const fmt = (ms: number | null) =>
  ms === null ? "-" : `${(ms / 1000).toFixed(1)}s`;
const median = (xs: number[]) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;

async function run() {
  button.disabled = true;
  grid.replaceChildren();
  const rec = (await (
    await fetch(`/__spike/recordings/${select.value}`)
  ).json()) as Recording;
  await fetch("/__spike/reset", { method: "POST" });
  const pages = Object.keys(rec.streams).filter((k) => k !== "mock.ts");
  const results: Result[] = [];
  const cells = new Map<string, HTMLElement>();
  const ready = new Set<string>();
  const allReady = new Promise<void>((ok) => {
    addEventListener("message", function onReady(e) {
      if (e.data?.kind === "host-ready") ready.add(e.data.name);
      if (pages.every((p) => ready.has(p))) {
        removeEventListener("message", onReady);
        ok();
      }
    });
  });
  for (const page of pages) {
    const col = document.createElement("div");
    col.innerHTML = `<b>${page}</b><div data-stats style="white-space:pre;font:12px ui-monospace;margin:4px 0"></div>`;
    const frame = document.createElement("div");
    frame.style.cssText = `width:${WIDTH * SCALE}px;height:${HEIGHT * SCALE}px;overflow:hidden;border:1px solid #d4d4d8;background:white`;
    const iframe = document.createElement("iframe");
    iframe.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px;border:0;transform:scale(${SCALE});transform-origin:0 0`;
    iframe.src = `/design/__stream/${page}`;
    iframe.dataset.page = page;
    frame.append(iframe);
    col.append(frame);
    grid.append(col);
    cells.set(page, col.querySelector("[data-stats]") as HTMLElement);
  }
  await allReady;
  const { start } = (await (
    await fetch(`/__spike/replay/${select.value}`, { method: "POST" })
  ).json()) as { start: number };
  for (const page of pages) {
    const s = rec.streams[page];
    results.push({
      page,
      firstChunk: start + s.chunks[0][0],
      finalAt: start + s.finalAt,
      firstPaint: null,
      meaningfulPaint: null,
      frames: 0,
      kept: 0,
      broken: [],
      watchMs: [],
      paintMs: [],
      publishMs: [],
    });
  }
  (window as unknown as { __replayResults: Result[] }).__replayResults =
    results;

  addEventListener("message", (e) => {
    const m = e.data;
    if (m?.type !== "appkit:stream-frame") return;
    const r = results.find((x) => x.page === m.name);
    if (!r) return;
    if (m.kind === "kept") {
      r.kept++;
      // Why versions were kept back, first time each reason was seen.
      const errors = ((r.keptErrors as Record<string, number>) ??= {});
      errors[m.error] ??= Math.round(m.t - r.firstChunk);
    }
    if (m.kind === "stream" && !m.done) {
      r.watchMs.push(m.seen - m.written);
      r.publishMs.push(m.published - m.seen);
      r.lastWritten = m.written;
    }
    if (m.kind === "frame") {
      r.frames++;
      if (r.lastWritten !== undefined && Date.now() < r.finalAt) {
        r.paintMs.push(Math.round(m.t - r.lastWritten));
      }
      // Broken: an error overlay, or a blank page after something was shown.
      if (m.overlay || (m.chars === 0 && r.firstPaint !== null))
        r.broken.push(Math.round(m.t - start));
      const since = Math.round(m.t - r.firstChunk);
      if (m.chars > 0) r.firstPaint ??= since;
      if (
        r.meaningfulPaint === null &&
        m.chars >= MEANINGFUL.chars &&
        m.height >= MEANINGFUL.height
      )
        r.meaningfulPaint = since;
    }
  });

  const tick = setInterval(() => {
    clock.textContent = fmt(Date.now() - start);
    for (const r of results) {
      (cells.get(r.page) as HTMLElement).textContent =
        `first chunk  ${fmt(r.firstChunk - start)}\n` +
        `first paint  +${fmt(r.firstPaint)}  meaningful +${fmt(r.meaningfulPaint)}\n` +
        `updates      ${r.frames} shown, ${r.kept} kept back, ${r.broken.length} broken\n` +
        `watch        ${Math.round(median(r.watchMs) ?? 0)} ms, publish ${median(r.publishMs) ?? "-"} ms (median)\n` +
        `final file   ${Date.now() >= r.finalAt ? `+${fmt(r.finalAt - r.firstChunk)}` : "-"}`;
    }
  }, 100);
  const end = Math.max(...results.map((r) => r.finalAt));
  // Then let the finished files' hot updates land.
  await new Promise((r) => setTimeout(r, end - Date.now() + 3000));
  clearInterval(tick);
  (window as unknown as { __replayDone: boolean }).__replayDone = true;
  button.disabled = false;
}

button.onclick = run;
if (params.has("autostart")) void run();

export {};
