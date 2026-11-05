// Example ../mock module for the example page.
export const kpis: {
  id: "revenue" | "customers" | "growth";
  label: string;
  value: string;
  delta: number;
}[] = [
  { id: "revenue", label: "Revenue", value: "$4.2M", delta: 12.4 },
  { id: "customers", label: "Active customers", value: "1,284", delta: 3.1 },
  { id: "growth", label: "Net growth", value: "8.7%", delta: -1.2 },
];

export const monthlyRevenue = [
  { month: "Jan", revenue: 310, target: 300 },
  { month: "Feb", revenue: 295, target: 305 },
  { month: "Mar", revenue: 340, target: 310 },
];

export const regions = [
  { region: "EMEA", revenue: 1400 },
  { region: "AMER", revenue: 2100 },
  { region: "APAC", revenue: 700 },
];

export const topDeals = [
  { account: "Northwind", region: "AMER", amount: 182000 },
  { account: "Contoso", region: "EMEA", amount: 96000 },
];
