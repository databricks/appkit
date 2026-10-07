import { gzipSync } from "node:zlib";

interface BundleSpec {
  name: string;
  description?: string;
  harness: string;
  model: string;
  /** Databricks profile the harness uses for model calls. */
  profile: string;
  instructions: string;
}

/**
 * An Omnigent agent bundle: `config.yaml` (the agent spec) and `AGENTS.md`
 * (the instructions), as a tar.gz. The YAML is written as JSON, which is
 * valid YAML.
 */
export function buildBundle(spec: BundleSpec): Buffer {
  const config = {
    spec_version: 1,
    name: spec.name,
    description: spec.description ?? spec.name,
    executor: {
      type: "omnigent",
      model: spec.model,
      profile: spec.profile,
      config: { harness: spec.harness },
      auth: { type: "databricks", profile: spec.profile },
    },
    instructions: "AGENTS.md",
  };
  const files: Record<string, string> = {
    "config.yaml": `${JSON.stringify(config, null, 2)}\n`,
    "AGENTS.md": spec.instructions,
  };
  return gzipSync(tar(files));
}

/** Minimal ustar writer: regular files only, names under 100 bytes. */
function tar(files: Record<string, string | Buffer>): Buffer {
  const blocks: Buffer[] = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const [name, content] of Object.entries(files)) {
    if (Buffer.byteLength(name) >= 100)
      throw new Error(`tar: name too long: ${name}`);
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write(`${mtime.toString(8).padStart(11, "0")}\0`, 136);
    header.write("        ", 148); // checksum placeholder
    header.write("0", 156);
    header.write("ustar\u000000", 257);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
