import { useAnalyticsQuery } from "@databricks/apps/react";

interface TopContributor {
  app_name: string;
  total_cost_usd: string | number;
}

interface TopContributorsProps {
  startDate: string;
  endDate: string;
}

export function TopContributors({ startDate, endDate }: TopContributorsProps) {
  const parameters = {
    startDate,
    endDate,
  };

  const { data, loading, error } = useAnalyticsQuery<TopContributor[]>(
    "top_contributors",
    parameters,
  );

  if (loading) {
    return (
      <div
        style={{
          padding: "20px",
          border: "1px solid #ddd",
          borderRadius: "8px",
          color: "#666",
        }}
      >
        <h3>Top Contributors</h3>
        <p>Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          padding: "20px",
          border: "1px solid #ddd",
          borderRadius: "8px",
        }}
      >
        <h3>Top Contributors</h3>
        <p style={{ color: "red" }}>Error: {error}</p>
      </div>
    );
  }

  const contributors = data || [];
  const maxCost = Math.max(
    ...contributors.map((c) => Number(c.total_cost_usd) || 0),
    1,
  );

  return (
    <div
      style={{
        padding: "24px",
        border: "none",
        borderRadius: "12px",
        backgroundColor: "#fff",
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.1)",
      }}
    >
      <h3
        style={{
          margin: "0 0 20px 0",
          color: "#1a1a1a",
          fontSize: "20px",
          fontWeight: "600",
        }}
      >
        Top Contributors (by App)
      </h3>
      <div>
        {contributors.length === 0 ? (
          <p style={{ color: "#666" }}>No data available</p>
        ) : (
          contributors.slice(0, 5).map((contributor) => {
            const cost = Number(contributor.total_cost_usd) || 0;
            const percentage = (cost / maxCost) * 100;
            return (
              <div key={contributor.app_name} style={{ marginBottom: "20px" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: "8px",
                  }}
                >
                  <span
                    style={{
                      fontWeight: "500",
                      color: "#333",
                      fontSize: "14px",
                    }}
                  >
                    {contributor.app_name || "Unknown"}
                  </span>
                  <span
                    style={{
                      fontWeight: "bold",
                      color: "#1a1a1a",
                      fontSize: "14px",
                    }}
                  >
                    ${cost.toFixed(2)}
                  </span>
                </div>
                <div
                  style={{
                    width: "100%",
                    height: "10px",
                    backgroundColor: "#e8e8e8",
                    borderRadius: "5px",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${percentage}%`,
                      height: "100%",
                      backgroundColor: "#1976d2",
                      transition: "width 0.3s ease",
                      borderRadius: "5px",
                    }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
