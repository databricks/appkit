import crypto from "node:crypto";
import type http from "node:http";
import path from "node:path";
import fs from "node:fs";

export function parseCookies(
  req: http.IncomingMessage,
): Record<string, string> {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return {};

  // Fast path: if there's no semicolon, there's only one cookie
  const semicolonIndex = cookieHeader.indexOf(";");
  if (semicolonIndex === -1) {
    const eqIndex = cookieHeader.indexOf("=");
    if (eqIndex === -1) return {};
    return {
      [cookieHeader.slice(0, eqIndex).trim()]: cookieHeader.slice(eqIndex + 1),
    };
  }

  // Multiple cookies: parse them all
  const cookies: Record<string, string> = {};
  const parts = cookieHeader.split(";");
  for (let i = 0; i < parts.length; i++) {
    const eqIndex = parts[i].indexOf("=");
    if (eqIndex !== -1) {
      const key = parts[i].slice(0, eqIndex).trim();
      const value = parts[i].slice(eqIndex + 1);
      cookies[key] = value;
    }
  }
  return cookies;
}

export function generateTunnelIdFromEmail(email?: string): string | undefined {
  if (!email) return undefined;

  const tunnelId = crypto
    .createHash("sha256")
    .update(email)
    .digest("base64url")
    .slice(0, 8);

  return tunnelId;
}

export function getRoutes(stack: unknown[], basePath = "") {
  const routes: Array<{ path: string; methods: string[] }> = [];

  stack.forEach((layer: any) => {
    if (layer.route) {
      // normal route
      const path = basePath + layer.route.path;
      const methods = Object.keys(layer.route.methods).map((m) =>
        m.toUpperCase(),
      );
      routes.push({ path, methods });
    } else if (layer.name === "router" && layer.handle.stack) {
      // nested router
      const nestedBase =
        basePath +
          layer.regexp.source
            .replace("^\\", "")
            .replace("\\/?(?=\\/|$)", "")
            .replace(/\\\//g, "/") // convert escaped slashes
            .replace(/\$$/, "") || "";
      routes.push(...getRoutes(layer.handle.stack, nestedBase));
    }
  });

  return routes;
}

export function getQueries(configFolder: string) {
  const queriesFolder = path.join(configFolder, "queries");

  if (!fs.existsSync(queriesFolder)) {
    return {};
  }

  return Object.fromEntries(
    fs
      .readdirSync(queriesFolder)
      .filter((f) => path.extname(f) === ".sql")
      .map((f) => [path.basename(f, ".sql"), path.basename(f, ".sql")]),
  );
}
