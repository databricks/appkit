# AppKit Documentation

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

Documentation is published on [DevHub](https://www.databricks.com/devhub/docs/appkit/v0/). GitHub Pages (`databricks.github.io/appkit/`) automatically redirects all existing URLs to DevHub via `.github/workflows/docs-deploy.yml`.

The `pnpm build` command:
1. Runs `docusaurus build` — generates HTML, `llms.txt`, and `.md` files
2. Runs `apply-redirects` — replaces HTML pages with redirect pages pointing to DevHub

Static files remain served from GitHub Pages: JSON schemas (`/schemas/`), `llms.txt`, and `.md` files (used by `npx @databricks/appkit docs` for npm-bundled documentation).
