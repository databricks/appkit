import {
  BarChart3Icon,
  BotIcon,
  DatabaseIcon,
  FileCode2Icon,
  FolderIcon,
  GaugeIcon,
  LayoutDashboardIcon,
  LineChartIcon,
  type LucideIcon,
  MessageCircleIcon,
  RadioIcon,
  SearchIcon,
  ServerIcon,
  ShieldIcon,
  ZapIcon,
} from "lucide-react";

/**
 * Metadata for a single demo route in the dev playground.
 *
 * `description` is used on the home page card. `icon` is used both on the
 * home page card and (optionally) in the nav dropdown. Keep `description`
 * to a single sentence — the home grid treats it as a one-line tagline.
 */
export interface NavItem {
  to: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

export interface NavGroup {
  id: "data" | "ai" | "platform";
  label: string;
  /** Short tagline shown under the section heading on the home page. */
  tagline: string;
  items: ReadonlyArray<NavItem>;
}

/**
 * Canonical demo catalog. Both the navigation dropdown in `__root.tsx` and
 * the landing grid in `index.tsx` render from this list, so adding a new
 * demo is a one-line change here and both surfaces pick it up.
 */
export const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  {
    id: "data",
    label: "Data",
    tagline: "Query, stream, and transform data with AppKit's data plugins.",
    items: [
      {
        to: "/analytics",
        label: "Analytics",
        description:
          "Query execution, charts, and interactive components against live SQL.",
        icon: BarChart3Icon,
      },
      {
        to: "/arrow-analytics",
        label: "Arrow Analytics",
        description:
          "Same dashboard — served over Apache Arrow streaming for zero-copy speed.",
        icon: ZapIcon,
      },
      {
        to: "/lakebase",
        label: "Lakebase",
        description:
          "Four takes on Postgres: raw driver, Drizzle, TypeORM, Sequelize with OAuth refresh.",
        icon: DatabaseIcon,
      },
      {
        to: "/sql-helpers",
        label: "SQL Helpers",
        description:
          "Type-safe parameter builders and query generators for Databricks SQL.",
        icon: FileCode2Icon,
      },
    ],
  },
  {
    id: "ai",
    label: "AI",
    tagline: "Agents, RAG, and LLM-powered UI built on AppKit primitives.",
    items: [
      {
        to: "/smart-dashboard",
        label: "Smart Dashboard",
        description:
          "Multi-agent NYC Taxi dashboard with live filters, highlights, approvals, and saved views.",
        icon: LayoutDashboardIcon,
      },
      {
        to: "/agent",
        label: "Custom Agent",
        description:
          "Chat agent over Databricks Model Serving with tools auto-discovered from AppKit plugins.",
        icon: BotIcon,
      },
      {
        to: "/genie",
        label: "Genie",
        description:
          "Natural-language Q&A against your data with SSE streaming and conversation persistence.",
        icon: MessageCircleIcon,
      },
      {
        to: "/chart-inference",
        label: "Chart Inference",
        description:
          "Let the agent pick the right chart type for a query result on the fly.",
        icon: LineChartIcon,
      },
      {
        to: "/vector-search",
        label: "Vector Search",
        description:
          "Semantic search backed by Databricks vector indexes, wired into AppKit's retrieval API.",
        icon: SearchIcon,
      },
      {
        to: "/serving",
        label: "Serving",
        description:
          "Call model-serving endpoints directly with the typed serving client.",
        icon: ServerIcon,
      },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    tagline:
      "Infrastructure demos: storage, policy, observability, resilience.",
    items: [
      {
        to: "/files",
        label: "Files",
        description:
          "Browse, preview, and download from Unity Catalog Volumes via the Files plugin.",
        icon: FolderIcon,
      },
      {
        to: "/policy-matrix",
        label: "Policy Matrix",
        description:
          "Resource policies, requested claims, and per-user authorisation flows.",
        icon: ShieldIcon,
      },
      {
        to: "/telemetry",
        label: "Telemetry",
        description:
          "OpenTelemetry traces and metrics with a drop-in AppKit provider.",
        icon: GaugeIcon,
      },
      {
        to: "/reconnect",
        label: "Reconnect",
        description:
          "Resilient SSE streams: automatic Last-Event-ID tracking and reconnection.",
        icon: RadioIcon,
      },
    ],
  },
];

/** All items flattened — useful for a search index or breadcrumb lookup. */
export const ALL_NAV_ITEMS: ReadonlyArray<NavItem> = NAV_GROUPS.flatMap(
  (g) => g.items,
);

/**
 * Resolve a pathname back to its nav item (for breadcrumbs, titles, etc).
 * Uses `startsWith` so nested routes like `/smart-dashboard/saved` match.
 */
export function findNavItemForPath(pathname: string): NavItem | null {
  for (const item of ALL_NAV_ITEMS) {
    if (pathname.startsWith(item.to)) return item;
  }
  return null;
}
