import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DbContext } from "../context";
import type {
  BranchSpec,
  LakebaseApi,
  LakebaseBranch,
  LakebaseDatabase,
  LakebaseEndpoint,
  LakebaseRole,
  RoleSpec,
} from "../lakebase-api";
import { LakebaseApiError } from "../lakebase-api";

/** In-memory Lakebase with the semantics init relies on: forks copy roles, endpoints come with new forks. */
export class FakeLakebase {
  readonly branches = new Map<string, LakebaseBranch>();
  readonly endpoints = new Map<string, LakebaseEndpoint[]>();
  readonly roles = new Map<string, LakebaseRole[]>();
  readonly databases = new Map<string, LakebaseDatabase>();
  readonly calls: string[] = [];
  /** New forks get a read-write `primary` endpoint, like Lakebase forks do. */
  autoEndpoint = true;
  createBranchError?: Error;
  deleteRoleError?: Error;

  addBranch(
    name: string,
    status: LakebaseBranch["status"] = {},
  ): LakebaseBranch {
    const branch = { name, status: { current_state: "READY", ...status } };
    this.branches.set(name, branch);
    this.endpoints.set(name, [this.endpoint(name, "primary")]);
    this.roles.set(name, []);
    return branch;
  }

  addRole(
    branch: string,
    roleId: string,
    postgresRole: string,
    memberships: string[] = [],
  ) {
    const role: LakebaseRole = {
      name: `${branch}/roles/${roleId}`,
      status: { postgres_role: postgresRole, membership_roles: memberships },
    };
    this.roles.get(branch)?.push(role);
    return role;
  }

  endpoint(branch: string, id: string): LakebaseEndpoint {
    return {
      name: `${branch}/endpoints/${id}`,
      status: {
        endpoint_type: "ENDPOINT_TYPE_READ_WRITE",
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
      async listBranches(project: string) {
        fake.calls.push(`listBranches ${project}`);
        return [...fake.branches.values()].filter((b) =>
          b.name.startsWith(`${project}/`),
        );
      },
      async createBranch(project: string, branchId: string, spec: BranchSpec) {
        fake.calls.push(`createBranch ${branchId} ${JSON.stringify(spec)}`);
        if (fake.createBranchError) throw fake.createBranchError;
        const name = `${project}/branches/${branchId}`;
        if (fake.branches.has(name)) {
          throw new LakebaseApiError(
            `create branch ${name}`,
            "ALREADY_EXISTS",
            {
              statusCode: 409,
              errorCode: "ALREADY_EXISTS",
            },
          );
        }
        const ttlSeconds = "ttl" in spec ? Number.parseInt(spec.ttl, 10) : 0;
        const branch: LakebaseBranch = {
          name,
          status: {
            current_state: "READY",
            source_branch: spec.source_branch,
            ...(ttlSeconds
              ? {
                  expire_time: new Date(
                    Date.now() + ttlSeconds * 1000,
                  ).toISOString(),
                }
              : {}),
          },
        };
        fake.branches.set(name, branch);
        fake.endpoints.set(
          name,
          fake.autoEndpoint ? [fake.endpoint(name, "primary")] : [],
        );
        // A fork copies the parent's roles.
        fake.roles.set(
          name,
          (fake.roles.get(spec.source_branch) ?? []).map((role) => ({
            ...role,
            name: `${name}/roles/${role.name.split("/").pop()}`,
          })),
        );
        return branch;
      },
      async listEndpoints(branch: string) {
        fake.calls.push(`listEndpoints ${branch}`);
        return fake.endpoints.get(branch) ?? [];
      },
      async createEndpoint(
        branch: string,
        endpointId: string,
        options: { suspendTimeout: string },
      ) {
        fake.calls.push(
          `createEndpoint ${branch} ${endpointId} suspend=${options.suspendTimeout}`,
        );
        const endpoint = fake.endpoint(branch, endpointId);
        fake.endpoints.set(branch, [
          ...(fake.endpoints.get(branch) ?? []),
          endpoint,
        ]);
        return endpoint;
      },
      async getDatabase(name: string) {
        fake.calls.push(`getDatabase ${name}`);
        return fake.databases.get(name) ?? null;
      },
      async listRoles(branch: string) {
        fake.calls.push(`listRoles ${branch}`);
        return [...(fake.roles.get(branch) ?? [])];
      },
      async createRole(branch: string, spec: RoleSpec) {
        fake.calls.push(`createRole ${branch} ${JSON.stringify(spec)}`);
        return fake.addRole(branch, "rol-generated", spec.postgres_role, [
          ...spec.membership_roles,
        ]);
      },
      async setRoleMemberships(role: string, memberships: string[]) {
        fake.calls.push(`setRoleMemberships ${role} ${memberships.join(",")}`);
        const branch = role.slice(0, role.indexOf("/roles/"));
        const found = fake.roles.get(branch)?.find((r) => r.name === role);
        if (!found?.status) throw new Error(`no role ${role}`);
        found.status.membership_roles = [...memberships];
        return found;
      },
      async deleteBranch(name: string) {
        fake.calls.push(`deleteBranch ${name}`);
        fake.branches.delete(name);
      },
      async deleteRole(role: string, options: { reassignOwnedTo: string }) {
        fake.calls.push(`deleteRole ${role} → ${options.reassignOwnedTo}`);
        if (fake.deleteRoleError) throw fake.deleteRoleError;
        const branch = role.slice(0, role.indexOf("/roles/"));
        fake.roles.set(
          branch,
          (fake.roles.get(branch) ?? []).filter((r) => r.name !== role),
        );
      },
    };
    return api as unknown as LakebaseApi;
  }
}

export const forbidden = () =>
  new LakebaseApiError("create branch", "PERMISSION_DENIED", {
    statusCode: 403,
  });

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
  /** The host the client resolved; empty when a test does not care. */
  host?: string;
}): DbContext {
  const userName = options.userName ?? "alice@example.com";
  return {
    root: options.root,
    env: { ...options.env },
    workspace: () => ({
      request: async () => {
        throw new Error("no raw API calls expected");
      },
      currentUser: { me: async () => ({ userName }) },
      getHost: async () => options.host ?? "",
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
