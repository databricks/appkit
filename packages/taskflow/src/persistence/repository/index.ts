export { LakebaseTaskRepository } from "./lakebase";
export type {
  LakebaseConnector,
  LakebaseRepositoryConfig,
} from "./lakebase/types";
export { SQLiteTaskRepository } from "./sqlite";
export type { SQLiteRepositoryConfig } from "./sqlite/types";
export type { StoredEvent, TaskRepository } from "./types";

import { noopHooks, type TaskSystemHooks } from "@/observability";
import type { LakebaseRepositoryConfig } from "./lakebase";
import type { SQLiteRepositoryConfig } from "./sqlite";
import type { TaskRepository } from "./types";

/**
 * Repository configuration union type
 */
export type RepositoryConfig =
  | SQLiteRepositoryConfig
  | LakebaseRepositoryConfig;

/**
 * Create a repository based on configuration
 * @param config - Repository configuration
 * @returns TaskRepository instance
 */
export async function createRepository(
  config: RepositoryConfig,
  hooks: TaskSystemHooks = noopHooks,
): Promise<TaskRepository> {
  let repository: TaskRepository;

  switch (config.type) {
    case "sqlite": {
      const { SQLiteTaskRepository } = await import("./sqlite");
      repository = new SQLiteTaskRepository(config, hooks);
      break;
    }
    case "lakebase": {
      const { LakebaseTaskRepository } = await import("./lakebase");
      repository = new LakebaseTaskRepository(config, hooks);
      break;
    }
    default: {
      const _exhaustiveCheck: never = config;
      throw new Error(
        `Unknown repository type: ${(_exhaustiveCheck as RepositoryConfig).type}`,
      );
    }
  }

  await repository.initialize();
  return repository;
}
