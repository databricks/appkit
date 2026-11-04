// One command to try it: starts the dev server (unless one is already up), writes the 3 drafts,
// prints their URLs and the timing table, then keeps the server running until Ctrl+C.
//
//   pnpm try --prompt "..." --answers "..." [--name myapp] [any other draft.ts flag]
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const url = "http://localhost:8000";
const up = () =>
  fetch(url).then(
    (r) => r.ok,
    () => false,
  );

let server: ReturnType<typeof spawn> | undefined;
if (!(await up())) {
  // Own process group, so Ctrl+C can stop pnpm's tsx-watch and node grandchildren too.
  server = spawn("pnpm", ["dev"], {
    cwd: root,
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 60 && !(await up()); i++)
    await new Promise((r) => setTimeout(r, 1000));
  if (!(await up()))
    throw new Error(
      "dev server did not start on :8000 (try `pnpm dev` to see why)",
    );
}

const draft = spawn(
  process.execPath,
  [
    path.join(import.meta.dirname, "draft.ts"),
    "--url",
    url,
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    stdio: "inherit",
  },
);
const code = await new Promise<number>((r) =>
  draft.on("exit", (c) => r(c ?? 1)),
);

if (!server) process.exit(code);
console.log("\nDev server running at", url, "(Ctrl+C to stop)");
process.on("SIGINT", () => {
  if (server.pid) process.kill(-server.pid);
  process.exit(code);
});
