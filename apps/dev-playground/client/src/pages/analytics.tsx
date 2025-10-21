import { useState } from "react";
import { SpendSummary } from "../components/analytics/spend-summary";
import { TopContributors } from "../components/analytics/top-contributors";

export function Analytics() {
  const [dateRange, setDateRange] = useState("last30");

  const getDateRange = () => {
    const endDate = new Date();
    const startDate = new Date();

    if (dateRange === "last7") {
      startDate.setDate(endDate.getDate() - 7);
    } else {
      startDate.setDate(endDate.getDate() - 30);
    }

    return {
      startDate: startDate.toISOString().split("T")[0],
      endDate: endDate.toISOString().split("T")[0],
    };
  };

  const dates = getDateRange();

  return (
    <div
      style={{
        padding: "40px",
        maxWidth: "1200px",
        margin: "0 auto",
        backgroundColor: "#f5f5f5",
      }}
    >
      <div style={{ marginBottom: "30px" }}>
        <h1
          style={{ margin: "0 0 10px 0", color: "#1a1a1a", fontSize: "32px" }}
        >
          Analytics Dashboard
        </h1>
        <p style={{ color: "#555", margin: "0 0 20px 0", fontSize: "16px" }}>
          Real-time insights from Databricks billing data
        </p>

        <div style={{ display: "flex", gap: "10px" }}>
          <button
            type="button"
            onClick={() => setDateRange("last7")}
            style={{
              padding: "10px 20px",
              border: "none",
              borderRadius: "6px",
              backgroundColor: dateRange === "last7" ? "#1976d2" : "#e0e0e0",
              color: dateRange === "last7" ? "#fff" : "#333",
              cursor: "pointer",
              fontSize: "14px",
              fontWeight: "500",
              transition: "all 0.2s",
            }}
          >
            Last 7 Days
          </button>
          <button
            type="button"
            onClick={() => setDateRange("last30")}
            style={{
              padding: "10px 20px",
              border: "none",
              borderRadius: "6px",
              backgroundColor: dateRange === "last30" ? "#1976d2" : "#e0e0e0",
              color: dateRange === "last30" ? "#fff" : "#333",
              cursor: "pointer",
              fontSize: "14px",
              fontWeight: "500",
              transition: "all 0.2s",
            }}
          >
            Last 30 Days
          </button>
        </div>
      </div>

      <div style={{ marginBottom: "30px" }}>
        <SpendSummary startDate={dates.startDate} endDate={dates.endDate} />
      </div>

      <div>
        <TopContributors startDate={dates.startDate} endDate={dates.endDate} />
      </div>
    </div>
  );
}
