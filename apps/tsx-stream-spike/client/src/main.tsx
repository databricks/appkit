import { createRoot } from "react-dom/client";

import "./index.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <p className="p-6">tsx-stream spike app: see /design/__replay</p>,
);
