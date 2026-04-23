---
endpoint: databricks-claude-sonnet-4-5
toolkits:
  - analytics
  - files
tools:
  - get_weather
  # Optional MCP servers — uncomment the ones whose env vars are set in
  # .env (VECTOR_SEARCH_MCP_URL, CUSTOM_MCP_URL). `server.ts` only
  # registers each as ambient when its URL is configured, so leaving a
  # reference here while the env var is unset will fail at startup.
  # - mcp.vector-search
  # - mcp.custom
---

You help customers with data analysis, file browsing, and general questions.
Use the available tools as needed and summarize results concisely.
