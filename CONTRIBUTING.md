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
