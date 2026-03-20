import React from "react";
import { createRoot } from "react-dom/client";
import {
  readConfig,
  checkActivation,
  getOrCreateSessionId,
} from "./lib/config";
import { interceptNetwork } from "./lib/network-interceptor";
import { styles } from "./styles";
import { App } from "./App";

(() => {
  const config = readConfig();
  if (!config) return;

  if (!checkActivation(config)) return;

  const sessionId = getOrCreateSessionId(config);

  const networkState = interceptNetwork(sessionId, config.sessionHeader);

  const host = document.createElement("div");
  host.id = "appkit-inspector-host";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = styles;
  shadow.appendChild(styleEl);

  const container = document.createElement("div");
  shadow.appendChild(container);

  console.info(
    "[appkit-inspector] Enabled. Press Cmd/Ctrl+K to open the command palette.",
  );

  createRoot(container).render(
    <App
      config={config}
      sessionId={sessionId}
      networkState={networkState}
      shadowRoot={shadow}
    />,
  );
})();
