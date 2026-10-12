import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DbContext } from "../context";
import type {
  LakebaseApi,
  LakebaseBranch,
  LakebaseEndpoint,
} from "../lakebase-api";

/** In-memory Lakebase: the branches the guard looks up, and their endpoints. */
export class FakeLakebase {
  readonly branches = new Map<string, LakebaseBranch>();
  readonly endpoints = new Map<string, LakebaseEndpoint[]>();
  readonly calls: string[] = [];

  addBranch(
    name: string,
    status: LakebaseBranch["status"] = {},
  ): LakebaseBranch {
    const branch = { name, status: { current_state: "READY", ...status } };
    this.branches.set(name, branch);
    this.endpoints.set(name, [this.endpoint(name, "primary")]);
    return branch;
  }

  endpoint(branch: string, id: string): LakebaseEndpoint {
    return {
      name: `${branch}/endpoints/${id}`,
      status: {
        hosts: { host: `${id}.${branch.split("/").pop()}.example.com` },
      },
    };
  }

  api(): LakebaseApi {
    const fake = this;
    const api = {
      async getBranch(name: string) {
        fake.calls.push(`getBranch ${name}`);
        return fake.branches.get(name) ?? null;
      },
      async getEndpoint(name: string) {
        fake.calls.push(`getEndpoint ${name}`);
        const branch = name.slice(0, name.indexOf("/endpoints/"));
        return (
          fake.endpoints
            .get(branch)
            ?.find((endpoint) => endpoint.name === name) ?? null
        );
      },
    };
    return api as unknown as LakebaseApi;
  }
}

const roots: string[] = [];

/** A temp app root with optional files (relative path → contents). */
export function tempApp(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-db-tooling-"));
  roots.push(root);
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  }
  return root;
}

export function cleanupTempApps(): void {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
}

export function fakeContext(options: {
  root: string;
  env?: NodeJS.ProcessEnv;
  userName?: string;
  api?: LakebaseApi;
}): DbContext {
  const userName = options.userName ?? "alice@example.com";
  return {
    root: options.root,
    env: { ...options.env },
    workspace: () => ({
      apiClient: {
        request: async () => {
          throw new Error("no raw API calls expected");
        },
      },
      currentUser: { me: async () => ({ userName }) },
    }),
    api: () => {
      if (!options.api) throw new Error("no Lakebase API calls expected");
      return options.api;
    },
  };
}

/** The bundle `databricks apps init` writes for a database app. */
export function databricksYml(branch: string, database: string): string {
  return `bundle:
  name: my-app
variables:
  postgres_branch:
    description: Lakebase branch resource name
  postgres_database:
    description: Lakebase database resource name
resources:
  apps:
    app:
      name: "my-app"
      source_code_path: ./
targets:
  default:
    default: true
    variables:
      postgres_branch: ${branch}
      postgres_database: ${database}
`;
}
