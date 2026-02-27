import path from "node:path";

export const TRUSTED_JS_MANIFEST_PACKAGE_PREFIXES = ["@databricks/"];

export function shouldAllowJsManifestForPackage(packageName: string): boolean {
  return TRUSTED_JS_MANIFEST_PACKAGE_PREFIXES.some((prefix) =>
    packageName.startsWith(prefix),
  );
}

export function getNodeModulesPackageName(filePath: string): string | null {
  const parts = path.resolve(filePath).split(path.sep).filter(Boolean);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1 || nodeModulesIndex + 1 >= parts.length) {
    return null;
  }

  const maybeScope = parts[nodeModulesIndex + 1];
  if (maybeScope.startsWith("@")) {
    const packageName = parts[nodeModulesIndex + 2];
    if (!packageName) return null;
    return `${maybeScope}/${packageName}`;
  }

  return maybeScope;
}

export function shouldAllowJsManifestForDir(dirPath: string): boolean {
  const packageName = getNodeModulesPackageName(dirPath);
  if (!packageName) return false;
  return shouldAllowJsManifestForPackage(packageName);
}
