import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

// StrictMode intentionally omitted: it double-mounts effects in dev and
// the analytics SSE hook treats the immediate AbortController teardown
// as a client cancel, which pushes the first task to `Cancelled` and
// muddies the durable-recovery demo (cancelled tasks aren't dedup
// targets, so re-clicks spawn fresh tasks).
const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(<App />);
