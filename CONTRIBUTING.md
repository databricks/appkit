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

After running this, you will need to write the DATABRICKS_HOST and your DEV_TOKEN in the .env file created in the app template [here](./apps/dev-playground/server/.env)

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
DATABRICKS_CLIENT_ID= 
DATABRICKS_CLIENT_SECRET=
```

## Adding new packages

To add a new sdk package, run the following command

```
pnpm create-package
```

It will prompt for a name and the type of package (backend or frontend).