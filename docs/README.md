# App Kit Documentation

This website is built using [Docusaurus](https://docusaurus.io/), a modern static website generator.

## Installation

Dependencies are installed automatically when running `pnpm install` from the repository root.

You can also install from the `docs/` directory:

```bash
pnpm install
```

## Local Development

```bash
pnpm dev
```

This command starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server.

## Build

```bash
pnpm build
```

This command generates static content into the `build` directory and can be served using any static contents hosting service.

## Deployment

Using SSH:

```bash
USE_SSH=true pnpm deploy
```

Not using SSH:

```bash
GIT_USER=<Your GitHub username> pnpm deploy
```

If you are using GitHub pages for hosting, this command is a convenient way to build the website and push to the `gh-pages` branch.
