import {
  ResourceStatusIndicator,
  ResourceStatusProvider,
} from "@databricks/appkit-ui/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";

import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <ResourceStatusProvider>
      <ResourceStatusIndicator />
      <App />
    </ResourceStatusProvider>
  </StrictMode>,
);
