import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { databaseSetupFailed } from "../../database/errors";
import { isDatabaseRoutes } from "./config";
import type { DatabaseRoutes } from "./operations";

const SOURCE_REGISTRY = "server/database/routes.gen.ts";

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw databaseSetupFailed("Could not read the default database routes.");
  }
}

/** Load the conventional registry, including the entry the server preset builds. */
export async function loadDefaultDatabaseRoutes(
  root = process.cwd(),
  entry = process.argv[1],
): Promise<DatabaseRoutes | undefined> {
  let file: string | undefined;
  if (entry && /\.[cm]?js$/.test(entry)) {
    const built = path.join(
      path.dirname(path.resolve(root, entry)),
      `database/routes.gen${path.extname(entry)}`,
    );
    if (await exists(built)) file = built;
  }
  if (!file) {
    const source = path.join(root, SOURCE_REGISTRY);
    if (await exists(source)) file = source;
    else if (await exists(path.join(root, "server/database/routes"))) {
      throw databaseSetupFailed(
        `Generate ${SOURCE_REGISTRY} with appkit generate-types before starting the app, or pass database({ routes: false }) to disable HTTP operations.`,
      );
    } else return undefined;
  }

  let module: unknown;
  try {
    if (file.endsWith(".ts")) {
      const { createJiti } = await import("jiti");
      module = await createJiti(import.meta.url, { moduleCache: false }).import(
        file,
      );
    } else {
      module = await import(pathToFileURL(file).href);
    }
  } catch {
    throw databaseSetupFailed(
      "Could not load the default database routes registry. Check its imports or pass an explicit routes registry.",
    );
  }
  const routes =
    typeof module === "object" && module !== null
      ? Reflect.get(module, "databaseRoutes")
      : undefined;
  if (!isDatabaseRoutes(routes)) {
    throw databaseSetupFailed(
      "The default database routes module must export the generated databaseRoutes registry.",
    );
  }
  return routes;
}
