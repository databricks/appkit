import { useEffect, useState } from "react";
import reactLogo from "./assets/react.svg";
import viteLogo from "/vite.svg";
import "./App.css";
import { Analytics } from "./pages/analytics";
import { Reconnect } from "./pages/reconnect";

function App() {
  const [count, setCount] = useState(0);
  const [data, setData] = useState<{ message: string } | null>(null);
  const [currentPage, setCurrentPage] = useState<
    "home" | "analytics" | "reconnect"
  >("home");

  useEffect(() => {
    fetch("/api/ping")
      .then((res) => res.json())
      .then((data) => setData(data));
  }, []);

  if (currentPage === "analytics") {
    return (
      <div>
        <div style={{ padding: "20px", borderBottom: "1px solid #ddd" }}>
          <button
            type="button"
            onClick={() => setCurrentPage("home")}
            style={{
              padding: "8px 16px",
              border: "1px solid #ddd",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            ← Back to Home
          </button>
        </div>
        <Analytics />
      </div>
    );
  }

  if (currentPage === "reconnect") {
    return <Reconnect />;
  }

  return (
    <>
      <div>
        <a href="https://vite.dev" target="_blank" rel="noopener">
          <img src={viteLogo} className="logo" alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank" rel="noopener">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <h1>Vite + React</h1>
      <div className="card">
        <button type="button" onClick={() => setCount((count) => count + 1)}>
          count is {count}
        </button>
        <p>
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
      </div>
      <div style={{ marginTop: "20px", display: "flex", gap: "10px" }}>
        <button
          type="button"
          onClick={() => setCurrentPage("analytics")}
          style={{
            padding: "10px 20px",
            fontSize: "16px",
            border: "2px solid #1976d2",
            borderRadius: "4px",
            backgroundColor: "#1976d2",
            color: "white",
            cursor: "pointer",
          }}
        >
          View Analytics Dashboard
        </button>
        <button
          type="button"
          onClick={() => setCurrentPage("reconnect")}
          style={{
            padding: "10px 20px",
            fontSize: "16px",
            border: "2px solid #1976d2",
            borderRadius: "4px",
          }}
        >
          View Reconnect
        </button>
      </div>
      <p className="read-the-docs">
        Click on the Vite and React logos to learn more
      </p>
      <p>{data?.message}</p>
    </>
  );
}

export default App;
