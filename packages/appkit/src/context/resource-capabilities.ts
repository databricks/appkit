import {
  APP_ONLY_RESOURCE_TYPES,
  SCOPE_BY_TYPE,
  type BasePluginConfig,
  type PluginConstructor,
} from "shared";

import { AppKitError } from "../errors/base";
import { getCallerContext, isLegacyCallerScope } from "./execution-context";
import { scopeApi } from "./scoped-api";

class AppOnlyResourceError extends AppKitError {
  readonly code = "APP_ONLY_RESOURCE";
  readonly statusCode = 400;
  readonly isRetryable = false;
  constructor(
    type: string,
    name = type === "postgres" || type === "database" ? "Lakebase" : "Secret",
  ) {
    const message = `${name} does not support OBO (on-behalf-of-user) execution; it runs as the service principal. Resource type: ${type}.`;
    super(message, { clientMessage: message, context: { resourceType: type } });
  }
}

/** Read the same required/bound resource metadata used by provisioning. */
export function getPluginResourceTypes(plugin: object): string[] {
  const ctor = plugin.constructor as Partial<PluginConstructor>;
  const config = (plugin as { config?: BasePluginConfig }).config;
  const resources = ctor.manifest?.resources;
  const optional =
    resources?.optional?.filter((resource) =>
      Object.values(resource.fields).some(
        (field) => field.env && process.env[field.env]?.trim(),
      ),
    ) ?? [];
  const runtime =
    config && ctor.getResourceRequirements
      ? ctor.getResourceRequirements(config)
      : [];
  return [
    ...new Set(
      [
        ...(resources?.required ?? []),
        ...optional,
        ...runtime.filter((resource) => resource.required),
      ].map((resource) => resource.type),
    ),
  ];
}

export function hasOboResource(types: readonly string[]): boolean {
  return types.some((type) => Object.hasOwn(SCOPE_BY_TYPE, type));
}

function isAppOnly(type: string): boolean {
  return [...APP_ONLY_RESOURCE_TYPES].some(
    (resourceType) => resourceType === type,
  );
}

export function assertResourceExecution(type: string): void {
  if (getCallerContext() && !isLegacyCallerScope() && isAppOnly(type))
    throw new AppOnlyResourceError(type);
}

export function assertPluginExecution(
  plugin: object,
  callerRequested = false,
): void {
  if (!callerRequested && (!getCallerContext() || isLegacyCallerScope()))
    return;
  for (const type of getPluginResourceTypes(plugin)) {
    if (isAppOnly(type)) throw new AppOnlyResourceError(type);
  }
}

/** Cached app handles still check the principal at invocation time. */
export function guardPluginApi<T>(plugin: object, value: T): T {
  if (!getPluginResourceTypes(plugin).some(isAppOnly)) return value;
  return scopeApi(
    value,
    {
      run: (fn) => {
        assertPluginExecution(plugin);
        return fn();
      },
    },
    plugin,
    true,
  );
}
