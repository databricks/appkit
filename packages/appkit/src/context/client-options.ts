import { coerce } from "semver";
import {
  name as productName,
  version as productVersion,
} from "../../package.json";
import type { ClientOptions } from "../workspace-client";

const normalizedVersion = (coerce(productVersion)?.version ??
  productVersion) as ClientOptions["productVersion"];

/**
 * SDK client options that stamp every `apiClient.request()` with an AppKit
 * User-Agent (`@databricks/appkit/<version>`), so outbound Databricks traffic
 * is attributable to AppKit. Use this for every `WorkspaceClient` AppKit
 * constructs at runtime.
 */
export function getClientOptions(): ClientOptions {
  const isDev = process.env.NODE_ENV === "development";

  return {
    product: productName,
    productVersion: normalizedVersion,
    ...(isDev && { userAgentExtra: { mode: "dev" } }),
  };
}

/**
 * Product/version User-Agent string matching the SDK stamp, for raw `fetch`
 * call sites that bypass the SDK's `apiClient` and have no client to derive it
 * from (e.g. the MCP connector).
 */
export const APPKIT_USER_AGENT = `${productName}/${normalizedVersion}`;
