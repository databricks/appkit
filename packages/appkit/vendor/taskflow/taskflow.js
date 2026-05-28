import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Load `taskflow-${platform}-${arch}.node`, with `taskflow.node` as fallback.
const platform = `${process.platform}-${process.arch}`;
const candidates = [`./taskflow-${platform}.node`, "./taskflow.node"];

let native;
const errors = [];
for (const candidate of candidates) {
  try {
    native = require(candidate);
    break;
  } catch (err) {
    errors.push(`${candidate}: ${err?.message ?? err}`);
  }
}

if (!native) {
  const detail = errors.map((e) => `  - ${e}`).join("\n");
  throw new Error(
    `[taskflow] No native binary found for ${platform}. Tried:\n${detail}\n` +
      `If you build from source, run \`bin/build-nodejs.sh\` for your platform; ` +
      `if you installed a published package, this platform is not in the prebuild matrix.`,
  );
}

export const Engine = native.Engine;
export const Taskflow = native.Taskflow;
export const workflow = native.workflow;
export default native;
