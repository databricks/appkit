const devEnvVars = ["DEV_TOKEN"];
const prodEnvVars = [
  "DATABRICKS_CLIENT_ID",
  "DATABRICKS_CLIENT_SECRET",
  "DATABRICKS_APP_NAME",
];
const commonEnvVars = ["DATABRICKS_HOST"];

export const envVars = [
  ...commonEnvVars,
  ...(process.env.NODE_ENV === "development" ? devEnvVars : prodEnvVars),
];
