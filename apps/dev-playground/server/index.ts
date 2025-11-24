import path from "node:path";
import { fileURLToPath } from "node:url";
import { analytics, createApp, server } from "@databricks/app-kit";
import dotenv from "dotenv";
import { reconnect } from "./reconnect-plugin";

// get __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, ".env") });

// define path to static files
const staticPath = path.resolve(__dirname, "..", "client", "dist");

createApp({
  plugins: [
    server({
      watch: process.env.NODE_ENV === "development",
      staticPath,
    }),
    reconnect(),
    analytics(),
  ],
});
