import { useAnalyticsQuery } from "@databricks/apps/react";

interface SpendSummaryData {
  total: number;
  average: number;
  forecasted: number;
}

interface SpendSummaryProps {
  startDate: string;
  endDate: string;
}

export function SpendSummary({ startDate, endDate }: SpendSummaryProps) {
  const parameters = {
    startDate,
    endDate,
    aggregationLevel: "day",
  };

  const { data, loading, error } = useAnalyticsQuery<SpendSummaryData[]>(
    "spend_summary",
    parameters,
  );

  if (loading) {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: "20px",
        }}
      >
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              padding: "20px",
              border: "1px solid #ddd",
              borderRadius: "8px",
            }}
          >
            <p style={{ color: "#666", fontSize: "13px", fontWeight: "500" }}>
              Loading...
            </p>
          </div>
        ))}
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
        <p style={{ color: "red" }}>Error: {error}</p>
      </div>
    );
  }

  const summary = data?.[0] || { total: "0", average: "0", forecasted: "0" };

  // Convert strings to numbers
  const metrics = {
    total: Number(summary.total) || 0,
    average: Number(summary.average) || 0,
    forecasted: Number(summary.forecasted) || 0,
  };

  const cards = [
    {
      title: "Total Spend",
      value: `$${(metrics.total / 1000).toFixed(1)}K`,
      description: "For selected period",
    },
    {
      title: "Average Daily",
      value: `$${metrics.average.toFixed(0)}`,
      description: "Average per day",
    },
    {
      title: "Forecasted",
      value: `$${(metrics.forecasted / 1000).toFixed(1)}K`,
      description: "+20% projection",
    },
  ];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: "20px",
      }}
    >
      {cards.map((card) => (
        <div
          key={card.title}
          style={{
            padding: "24px",
            border: "none",
            borderRadius: "12px",
            backgroundColor: "#fff",
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.1)",
          }}
        >
          <p
            style={{
              margin: "0 0 12px 0",
              color: "#666",
              fontSize: "13px",
              fontWeight: "500",
              textTransform: "uppercase",
              letterSpacing: "0.5px",
            }}
          >
            {card.title}
          </p>
          <p
            style={{
              margin: "0 0 8px 0",
              fontSize: "36px",
              fontWeight: "bold",
              color: "#1a1a1a",
            }}
          >
            {card.value}
          </p>
          <p style={{ margin: 0, color: "#777", fontSize: "13px" }}>
            {card.description}
          </p>
        </div>
      ))}
    </div>
  );
}
