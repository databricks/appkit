import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The Databricks profile the children use; it points at the model gateway. */
export const GATEWAY_PROFILE = "appkit-omnigent";

/**
 * Directory layout under the runtime root:
 *
 *   server/            Omnigent server data
 *   users/<id>/home    one user's $HOME: Databricks profile, Omnigent config
 *   users/<id>/data    that user's host data
 *   work/<id>          that user's workspace (sessions' cwd)
 *   bin/               public: CA bundle
 *   tls/               gateway key
 *   logs/
 */
export class RuntimeLayout {
  constructor(readonly root: string) {}

  static userId(email: string): string {
    return createHash("sha256")
      .update(email.toLowerCase())
      .digest("hex")
      .slice(0, 16);
  }

  get serverDir() {
    return path.join(this.root, "server");
  }
  get bin() {
    return path.join(this.root, "bin");
  }
  get tls() {
    return path.join(this.root, "tls");
  }
  get logs() {
    return path.join(this.root, "logs");
  }
  userHome(id: string) {
    return path.join(this.root, "users", id, "home");
  }
  userData(id: string) {
    return path.join(this.root, "users", id, "data");
  }
  userWork(id: string) {
    return path.join(this.root, "work", id);
  }

  create(): void {
    for (const d of [this.root, this.serverDir, this.bin, this.logs]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
}

interface GatewayEndpoints {
  httpsUrl: string;
  placeholder: string;
}

/**
 * Writes a user's `$HOME` config: a `.databrickscfg` whose profile points at
 * the gateway with the placeholder token (no real credential), and an
 * Omnigent `config.yaml` that authenticates through that profile.
 */
export function writeUserConfig(home: string, gw: GatewayEndpoints): void {
  fs.mkdirSync(path.join(home, ".config", "omnigent"), { recursive: true });
  const cfg = [
    `[${GATEWAY_PROFILE}]`,
    `host = ${gw.httpsUrl}`,
    `token = ${gw.placeholder}`,
    "auth_type = pat",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(home, ".databrickscfg"), cfg, { mode: 0o600 });
  const omnigentConfig = [
    "auth:",
    "  type: databricks",
    `  profile: ${GATEWAY_PROFILE}`,
    "",
  ].join("\n");
  fs.writeFileSync(
    path.join(home, ".config", "omnigent", "config.yaml"),
    omnigentConfig,
  );
}

/** Environment variables a child must never inherit. */
const STRIPPED = [
  /^DATABRICKS_(CLIENT_ID|CLIENT_SECRET|TOKEN|HOST|CONFIG_PROFILE|CONFIG_FILE)$/,
  /^(PGPASSWORD|OMNIGENT_KEY_SECRET)$/,
  /^(CLAUDE|CLAUDECODE|UVICORN|npm_)/,
  /^NODE_OPTIONS$/,
];

interface ChildEnvOptions {
  home: string;
  dataDir: string;
  gateway: GatewayEndpoints;
  caBundle: string;
  caCert: string;
  pathPrepend: string[];
  extra?: Record<string, string | undefined>;
}

/**
 * The environment of an Omnigent child: the app's environment minus every
 * credential, with the gateway as its Databricks host and its trust stores
 * extended with the gateway's certificate.
 */
export function childEnv(
  base: NodeJS.ProcessEnv,
  opts: ChildEnvOptions,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || STRIPPED.some((re) => re.test(k))) continue;
    env[k] = v;
  }
  Object.assign(env, {
    HOME: opts.home,
    OMNIGENT_DATA_DIR: opts.dataDir,
    OMNIGENT_CONFIG_HOME: path.join(opts.home, ".config", "omnigent"),
    DATABRICKS_CONFIG_FILE: path.join(opts.home, ".databrickscfg"),
    DATABRICKS_HOST: opts.gateway.httpsUrl,
    SSL_CERT_FILE: opts.caBundle,
    REQUESTS_CA_BUNDLE: opts.caBundle,
    NODE_EXTRA_CA_CERTS: opts.caCert,
    OMNIGENT_SKIP_UPDATE_CHECK: "1",
    OMNIGENT_UPDATE_CHECK: "0",
    NO_COLOR: "1",
    PYTHONUNBUFFERED: "1",
    PATH: [...opts.pathPrepend, base.PATH ?? ""]
      .filter(Boolean)
      .join(path.delimiter),
  });
  for (const [k, v] of Object.entries(opts.extra ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}
