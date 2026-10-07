import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ModelGateway } from "../runtime/gateway";
import { ensureGatewayTls } from "../runtime/tls";

function get(
  url: string,
  ca: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers, ca }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

describe("ModelGateway", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-gw-"));
  let gw: ModelGateway;
  let cert: Buffer;
  let tokenCalls = 0;

  beforeAll(async () => {
    const tls = ensureGatewayTls(
      path.join(root, "tls"),
      path.join(root, "bin"),
    );
    cert = tls.cert;
    gw = new ModelGateway({
      upstream: "https://127.0.0.1:9", // never reached in these tests
      token: async () => {
        tokenCalls++;
        return "real-token";
      },
      tls,
    });
    await gw.start();
  });

  afterAll(async () => {
    await gw.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("TLS material: key private, cert and bundle public", () => {
    expect(fs.existsSync(path.join(root, "tls", "key.pem"))).toBe(true);
    expect(
      fs.readFileSync(path.join(root, "bin", "ca-bundle.pem"), "utf8"),
    ).toContain("BEGIN CERTIFICATE");
    expect(
      fs.readdirSync(path.join(root, "bin")).some((f) => f.includes("key")),
    ).toBe(false);
  });

  test("permits model paths with the placeholder or no auth, nothing else", () => {
    const ph = `Bearer ${gw.placeholder}`;
    expect(gw.permits("/ai-gateway/anthropic/v1/messages", ph)).toBe(true);
    expect(
      gw.permits(
        "/serving-endpoints/databricks-gpt-5-5/invocations",
        undefined,
      ),
    ).toBe(true);
    expect(gw.permits("/api/2.0/serving-endpoints", ph)).toBe(true);
    expect(
      gw.permits("/api/2.1/unity-catalog/model-services?parent=x", ph),
    ).toBe(true);
    expect(gw.permits("/api/2.0/clusters/list", ph)).toBe(false);
    expect(gw.permits("/api/2.0/sql/statements", ph)).toBe(false);
    expect(gw.permits("/api/2.1/unity-catalog/tables", ph)).toBe(false);
    expect(
      gw.permits("/ai-gateway/anthropic/v1/messages", "Bearer something-else"),
    ).toBe(false);
  });

  test("refuses non-model paths with 403 and never mints a token for them", async () => {
    const before = tokenCalls;
    const r = await get(`${gw.httpsUrl}/api/2.0/clusters/list`, cert, {
      authorization: `Bearer ${gw.placeholder}`,
    });
    expect(r.status).toBe(403);
    expect(tokenCalls).toBe(before);
    expect(gw.stats.denied).toBeGreaterThan(0);
  });

  test("answers host metadata with 404 so SDKs stay on token auth", async () => {
    const r = await get(`${gw.httpsUrl}/.well-known/databricks-config`, cert);
    expect(r.status).toBe(404);
  });

  test("listens on loopback only", () => {
    expect(gw.httpsUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
  });
});
