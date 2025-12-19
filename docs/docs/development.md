---
sidebar_position: 3
---

# Development

- Point to https://docs.databricks.com/aws/en/dev-tools/cli/install for installation instructions as a prerequisite
- General docs are here: https://docs.databricks.com/aws/en/dev-tools/cli/

Create sections:

- Without AI: local development
  - start with the clean-app template and run `pnpm dev` to start the development server
  - hot reload for UI and backend code

- With AI: databricks experimental apps-mcp install https://github.com/databricks/cli/blob/main/experimental/apps-mcp/README.md
  - configure mcp for claude code, cursor or others as a part of the command setup

		Use:    "apps-mcp",
		Hidden: true,
		Short:  "Model Context Protocol server for AI agents",
		Long: `Start and manage an MCP server that provides AI agents with tools to interact with Databricks.

The MCP server exposes the following capabilities:
- Data exploration (query catalogs, schemas, tables, execute SQL)
- CLI command execution (bundle, apps, workspace operations)
- Workspace resource discovery

The server communicates via stdio using the Model Context Protocol.`,
		Example: `  # Start MCP server with required warehouse
  databricks experimental apps-mcp --warehouse-id abc123`,


- Against deployed app backend (tunneling)

    databricks apps dev-remote --app-name {app-name}

    here's about the command: 

	cmd.Use = "dev-remote"
	cmd.Hidden = true
	cmd.Short = `Run Databricks app locally with WebSocket bridge to remote server.`
	cmd.Long = `Run Databricks app locally with WebSocket bridge to remote server.

  Starts a local development server and establishes a WebSocket bridge
  to the remote Databricks app for development.
    `

	cmd.PreRunE = root.MustWorkspaceClient

	cmd.Flags().StringVar(&appName, "app-name", "", "Name of the app to connect to (required)")
	cmd.Flags().StringVar(&clientPath, "client-path", "./client", "Path to the Vite client directory")
	cmd.Flags().IntVar(&port, "port", vitePort, "Port to run the Vite server on")

    basically the hot reload works for UI and queries, and the deployed backend code is used
    you need to approve a given connection request from the terminal
    