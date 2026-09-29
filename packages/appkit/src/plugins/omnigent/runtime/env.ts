import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Databricks profile names the children use; both point at the model gateway. */
const PROFILE_HTTPS = "appkit-omnigent";
const PROFILE_HTTP = "appkit-omnigent-http";

/** Harnesses whose TLS stack only trusts public roots use the plain-http listener. */
export function profileFor(harness: string): string {
  return harness.startsWith("codex") ? PROFILE_HTTP : PROFILE_HTTPS;
}

/**
 * Directory layout under the runtime root:
 *
 *   server/            Omnigent server data (masked from harnesses)
 *   users/<id>/home    one user's $HOME: Databricks profile, Omnigent config
 *   users/<id>/data    that user's host data
 *   work/<id>          that user's workspace (sessions' cwd)
 *   bin/               public: sandbox wrappers, CA bundle
 *   tls/               gateway key (masked)
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
  httpUrl: string;
  placeholder: string;
}

/**
 * Writes a user's `$HOME` config: a `.databrickscfg` whose two profiles point
 * at the gateway with the placeholder token (no real credential), and an
 * Omnigent `config.yaml` that authenticates through the https one.
 */
export function writeUserConfig(home: string, gw: GatewayEndpoints): void {
  fs.mkdirSync(path.join(home, ".config", "omnigent"), { recursive: true });
  const cfg = [
    `[${PROFILE_HTTPS}]`,
    `host = ${gw.httpsUrl}`,
    `token = ${gw.placeholder}`,
    "auth_type = pat",
    "",
    `[${PROFILE_HTTP}]`,
    `host = ${gw.httpUrl}`,
    `token = ${gw.placeholder}`,
    "auth_type = pat",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(home, ".databrickscfg"), cfg, { mode: 0o600 });
  const omnigentConfig = [
    "auth:",
    "  type: databricks",
    `  profile: ${PROFILE_HTTPS}`,
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
