## Developer Certificate of Origin

To contribute to this repository, you must sign off your commits to certify 
that you have the right to contribute the code and that it complies with the 
open source license. The rules are pretty simple, if you can certify the 
content of [DCO](./DCO), then simply add a "Signed-off-by" line to your 
commit message to certify your compliance. Please use your real name as 
pseudonymous/anonymous contributions are not accepted.

```
Signed-off-by: Joe Smith <joe.smith@email.com>
```

If you set your `user.name` and `user.email` git configs, you can sign your 
commit automatically with `git commit -s`:

```
git commit -s -m "Your commit message"
```

# Requirements

This project needs some dependencies in order to run, make sure to have them all installed.

### npm

Make sure to have node installed using [nvm](https://github.com/nvm-sh/nvm)

> **Note:** This project requires Node.js version 24. If you use nvm, you can install it using:
> ```bash
> nvm install 24
> nvm use 24
> ```

### pnpm

Run the following command

```bash
npm install --global corepack@latest
corepack enable pnpm
```

Now you can run the following command to setup your environment

```bash
pnpm setup:repo
```

After running this, you will need to write the DATABRICKS_HOST in the .env file created in the app template [here](./apps/dev-playground/server/.env)

Documentation to obtain the dev token [here](https://docs.databricks.com/aws/en/dev-tools/auth/pat#databricks-personal-access-tokens-for-workspace-users)


## Starting the project

The following command will compile all the packages and app in watch mode.

```bash
pnpm dev
```

> **Note:** To avoid port collisions with the `clean-app` example, you should create a `.env` file in `apps/dev-playground` and set another port for this app:
>
> ```
> DATABRICKS_APP_PORT=8001
> ```


## Running the project in production mode

Running the following command

```bash
pnpm start
```

will run all the builds and then start the app project. In order to make this work you will need to have the following env vars in your .env file

```
DATABRICKS_HOST=
```

## Deploying the playground app

The playground app can be deployed to Databricks using the following command:

```bash
pnpm pack:sdk
pnpm deploy:playground
```

You can set the following environment variables to the command to customize the deployment:

```bash
export DATABRICKS_PROFILE=your-profile # Databricks profile name. Used as a Databricks CLI profile argument whenever a command is executed.
export DATABRICKS_APP_NAME=your-app-name # The name of the app to deploy. If not provided, it will be prefixed with the username.
export DATABRICKS_WORKSPACE_DIR=your-workspace-dir # The source workspace directory to deploy the app from. It will be used to construct the absolute path: /Workspace/Users/{your-username}/{workspace-dir}
```

## Generating App templates

The single source template (`template/`) is used to generate app variants for the [`app-templates`](https://github.com/databricks/app-templates) repository. The variants and post-processing steps are defined in `tools/generate-app-templates.ts`.

```bash
pnpm generate:app-templates
```

By default, this outputs to `../app-templates`, assuming the repo is cloned alongside this one.

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_TEMPLATES_OUTPUT_DIR` | `../app-templates` | Output directory |
| `DATABRICKS_CLI` | `databricks` | CLI binary name or path |

## Contributing to AppKit documentation

The `docs/` directory contains the AppKit documentation site, built with Docusaurus.

**Working with docs:**

```bash
# From root
pnpm docs:dev    # Start dev server
pnpm docs:build  # Build docs
pnpm docs:serve  # Serve built docs
```

See [docs/README.md](./docs/README.md) for more details.

## Adding or changing a resource type

Resource types and their permissions are defined once in the plugin-manifest schema; the CLI (create, add-resource, validate) and the appkit registry types are derived from it.

To add or change a resource type:

1. **Edit the schema** – `packages/shared/src/schemas/plugin-manifest.schema.json`:
   - Add the value to `$defs.resourceType.enum`.
   - Add a permission definition (e.g. `$defs.myResourcePermission`) with an `enum` array; list permissions **weakest to strongest** (this order is used for merge/escalation).
   - In `$defs.resourceRequirement.allOf`, add a branch with `if.properties.type.const` set to the new type and `then.properties.permission.$ref` pointing at that permission def (e.g. `#/$defs/myResourcePermission`).

2. **Regenerate registry types** – from the repo root:
   ```bash
   pnpm exec tsx tools/generate-registry-types.ts
   ```
   This updates `packages/appkit/src/registry/types.generated.ts`. The appkit build runs this automatically before compiling.

3. **Optional:** Add default fields for the new type in `packages/shared/src/cli/commands/plugin/create/resource-defaults.ts` (`DEFAULT_FIELDS_BY_TYPE`) so the plugin create/add-resource prompts suggest env vars.

For more context and alternative approaches, see [Registry types from schema](./docs/docs/development/registry-types-from-schema.md).
