import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface GatewayTls {
  key: Buffer;
  cert: Buffer;
  /** The certificate alone (for `NODE_EXTRA_CA_CERTS`). */
  certFile: string;
  /** System roots plus the certificate (for `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE`). */
  bundleFile: string;
}

const SYSTEM_ROOTS = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/cert.pem",
];

/**
 * A self-signed certificate for `127.0.0.1`, made once per runtime directory
 * with the system `openssl`, and a CA bundle that trusts it alongside the
 * system roots. The key stays in `privateDir` (masked from sandboxed
 * harnesses); the certificate and bundle go to `publicDir`, which they read.
 */
export function ensureGatewayTls(
  privateDir: string,
  publicDir: string,
): GatewayTls {
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(publicDir, { recursive: true });
  const keyFile = path.join(privateDir, "key.pem");
  const certFile = path.join(publicDir, "gateway-cert.pem");
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "30",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        keyFile,
        "-out",
        certFile,
      ],
      { stdio: "ignore" },
    );
    fs.chmodSync(keyFile, 0o600);
  }
  const cert = fs.readFileSync(certFile);
  const roots = SYSTEM_ROOTS.find((f) => fs.existsSync(f));
  const bundleFile = path.join(publicDir, "ca-bundle.pem");
  fs.writeFileSync(
    bundleFile,
    `${roots ? fs.readFileSync(roots, "utf8") : ""}\n${cert.toString("utf8")}`,
  );
  return { key: fs.readFileSync(keyFile), cert, certFile, bundleFile };
}
