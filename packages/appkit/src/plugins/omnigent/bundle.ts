import { gzipSync } from "node:zlib";

/** A stdio MCP server the session's host starts. */
export interface McpServerSpec {
  name: string;
  description?: string;
  transport: "stdio";
  command: string;
  args: string[];
  /** Seconds. */
  timeout?: number;
}

interface BundleSpec {
  name: string;
  description?: string;
  harness: string;
  model: string;
  instructions: string;
  mcpServers?: McpServerSpec[];
}

/**
 * An Omnigent agent bundle: `config.yaml` (the agent spec), `AGENTS.md` (the
 * instructions) and one `tools/mcp/<name>.yaml` per MCP server, as a tar.gz.
 * The YAML files are written as JSON, which is valid YAML.
 */
export function buildBundle(spec: BundleSpec): Buffer {
  const config = {
    spec_version: 1,
    name: spec.name,
    description: spec.description ?? spec.name,
    executor: {
      type: "omnigent",
      model: spec.model,
      config: { harness: spec.harness },
    },
    instructions: "AGENTS.md",
  };
  const files: Record<string, string> = {
    "config.yaml": `${JSON.stringify(config, null, 2)}\n`,
    "AGENTS.md": spec.instructions,
  };
  for (const s of spec.mcpServers ?? []) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(s.name)) {
      throw new Error(`Invalid MCP server name: ${s.name}`);
    }
    if (files[`tools/mcp/${s.name}.yaml`]) {
      throw new Error(`Duplicate MCP server name: ${s.name}`);
    }
    files[`tools/mcp/${s.name}.yaml`] = `${JSON.stringify(
      {
        name: s.name,
        description: s.description ?? s.name,
        transport: s.transport,
        command: s.command,
        args: s.args,
        timeout: s.timeout ?? 300,
      },
      null,
      2,
    )}\n`;
  }
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
