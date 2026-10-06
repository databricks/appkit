import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

type DatabricksCliRunner = (
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<{ stdout: string }>;

const runDatabricksCli: DatabricksCliRunner = (args, env) =>
  execute("databricks", args, { env, timeout: 30_000 });

export interface DevOboIdentity {
  token: string;
  userId: string;
  email?: string;
}

function identityFromUser(token: string, userOutput: string): DevOboIdentity {
  const user = JSON.parse(userOutput);
  if (
    !token.trim() ||
    typeof user.id !== "string" ||
    !user.id.trim() ||
    user.applicationId ||
    user.schemas?.some((schema: string) => schema.endsWith(":ServicePrincipal"))
  )
    throw new Error();
  return {
    token,
    userId: user.id,
    email: typeof user.userName === "string" ? user.userName : undefined,
  };
}

/** CLI output is credential-bearing. Never include it in an error or log. */
export async function loadDevOboIdentity(
  profile: string,
  run: DatabricksCliRunner = runDatabricksCli,
): Promise<DevOboIdentity> {
  try {
    if (!profile.trim()) throw new Error();
    const [tokenOutput, userOutput] = await Promise.all([
      run(["auth", "token", "--profile", profile]),
      run(["current-user", "me", "--profile", profile, "--output", "json"]),
    ]);
    const token = JSON.parse(tokenOutput.stdout).access_token;
    if (typeof token !== "string") throw new Error();
    return identityFromUser(token, userOutput.stdout);
  } catch {
    throw new Error(
      "Unable to obtain local OBO credentials. Authenticate the explicitly selected Databricks user profile and retry.",
    );
  }
}

/** Prefer explicit token credentials, then fall back to an explicit profile. */
export async function loadDevOboIdentityFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  run: DatabricksCliRunner = runDatabricksCli,
): Promise<DevOboIdentity> {
  const token = env.DATABRICKS_TOKEN?.trim();
  if (!token) {
    return loadDevOboIdentity(env.DATABRICKS_CONFIG_PROFILE ?? "", run);
  }

  try {
    const host = env.DATABRICKS_HOST?.trim();
    if (!host) throw new Error();
    const tokenEnvironment = { ...env };
    delete tokenEnvironment.DATABRICKS_CONFIG_PROFILE;
    tokenEnvironment.DATABRICKS_HOST = host;
    tokenEnvironment.DATABRICKS_TOKEN = token;
    const userOutput = await run(
      ["current-user", "me", "--host", host, "--output", "json"],
      tokenEnvironment,
    );
    return identityFromUser(token, userOutput.stdout);
  } catch {
    throw new Error(
      "Unable to obtain local OBO identity from DATABRICKS_TOKEN. Set DATABRICKS_HOST for the same workspace and verify the token belongs to a user.",
    );
  }
}

/** Share concurrent refreshes and keep credentials only in memory. */
export function createDevOboIdentityProvider(
  load: () => Promise<DevOboIdentity>,
): () => Promise<DevOboIdentity> {
  let identity: DevOboIdentity | undefined;
  let loadedAt = 0;
  let refresh: Promise<DevOboIdentity> | undefined;
  return async () => {
    if (identity && Date.now() - loadedAt < 30_000) return identity;
    refresh ??= load()
      .then((next) => {
        identity = next;
        loadedAt = Date.now();
        return next;
      })
      .finally(() => {
        refresh = undefined;
      });
    return refresh;
  };
}
