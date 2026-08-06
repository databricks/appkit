import {
  formatLabel,
  formatValue,
  type MetricFilter,
  toMetricFilter,
} from "@databricks/appkit-ui/js";
import {
  Badge,
  BarChart,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DonutChart,
  LineChart,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useMetricView,
} from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import { FilterIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Header } from "@/components/layout/header";

export const Route = createFileRoute("/metric-views")({
  component: MetricViewsRoute,
});

// Columns each visual asks the `revenue` metric view for. Declared at module
// scope so their array identities stay stable across renders — `useMetricView`
// serializes the request body, so this also keeps each SSE subscription from
// re-firing on unrelated state changes. Measure / dimension names and the row
// shape are inferred from the generated `MetricRegistry` augmentation
// (shared/appkit-types/metric-views.ts).
const REGION_DIM = ["region"] as const;
const SEGMENT_DIM = ["segment"] as const;
const TIME_DIM = ["created_at"] as const;
const ARR_MEASURE = ["arr"] as const;
const TREND_MEASURES = ["arr", "mrr"] as const;
const TABLE_MEASURES = ["arr", "mrr", "new_arr", "churned_arr"] as const;
const TABLE_COLUMNS = ["region", ...TABLE_MEASURES] as const;

// The dimensions the page lets you slice by. The filter-bar dropdowns, the
// detail-table row click, AND the chart clicks (region bar / segment donut)
// all write selections keyed by these names, and every visual composes them
// into a `MetricFilter` the same way — one shared `selection` state drives them.
const FILTER_DIMENSIONS = ["region", "segment"] as const;
type FilterDimension = (typeof FILTER_DIMENSIONS)[number];
// `null` is a real selection — "the rows where this dimension IS NULL" — and is
// distinct from a dimension being absent (no filter). `toMetricFilter` compiles
// it to `notSet`; stringifying it to "null" would instead build `equals 'null'`
// and match nothing.
type Selection = Partial<Record<FilterDimension, string | null>>;

// Radix `Select` forbids an empty-string item value, so explicit sentinels stand
// in for the "no filter on this dimension" choice and for a NULL group key
// (which has no string form of its own that couldn't collide with real data).
const ALL = "__all__";
const NONE = "__none__";

/** Label shown for a NULL group key. */
const NONE_LABEL = "(none)";

/**
 * A dimension value as a `Select` item value: real values pass through, a NULL
 * group key becomes the {@link NONE} sentinel.
 */
function toItemValue(value: string | null): string {
  return value === null ? NONE : value;
}

/** Inverse of {@link toItemValue} — maps the sentinels back to a selection. */
function fromItemValue(value: string): string | null | undefined {
  if (value === ALL) return undefined;
  return value === NONE ? null : value;
}

/** Display label for a selected dimension value, naming the NULL case. */
function toDisplayLabel(value: string | null): string {
  return value === null ? NONE_LABEL : value;
}

/**
 * A clicked chart category as a selection value. Charts normalize a NULL
 * category key to `""` (see `normalizeChartData`), so an empty name means "the
 * NULL group" — map it back to `null` for an `IS NULL` filter rather than an
 * `equals ''` that matches nothing.
 */
function fromChartName(name: string): string | null {
  return name === "" ? null : name;
}

/**
 * The distinct values of one dimension across a breakdown's rows, for a dropdown
 * domain. A NULL group key is kept as `null` (never `String(null)`), sorted last.
 */
function toDimensionOptions(
  rows: Array<Record<string, unknown>> | null,
  dimension: FilterDimension,
): (string | null)[] {
  let hasNull = false;
  const values = new Set<string>();
  for (const row of rows ?? []) {
    const value = row[dimension];
    if (value === null || value === undefined) hasNull = true;
    else values.add(String(value));
  }
  const sorted: (string | null)[] = Array.from(values).sort();
  if (hasNull) sorted.push(null);
  return sorted;
}

/**
 * Compose the active selection into a `MetricFilter`, optionally excluding one
 * dimension. Excluding a visual's own grouping dimension is what makes this a
 * *cross*-filter rather than a global filter: the by-region chart keeps every
 * region visible when a region is selected (so you can pick another), while the
 * charts grouped by *other* dimensions narrow to that region.
 *
 * The map-to-`MetricFilter` compilation itself is the SDK's `toMetricFilter`
 * (from `@databricks/appkit-ui/js`) — this wrapper only adds the cross-filter
 * facet-exclusion, which is app-specific and stays local.
 */
function buildFilter(
  selection: Selection,
  exclude?: FilterDimension,
): MetricFilter | undefined {
  const shorthand: Record<string, string | null> = {};
  for (const dimension of FILTER_DIMENSIONS) {
    const value = selection[dimension];
    if (dimension === exclude || value === undefined) continue;
    shorthand[dimension] = value;
  }
  return toMetricFilter(shorthand);
}

/**
 * The dimensions actually shaping a card's data, given the shared selection and
 * the card's own excluded dimension. Mirrors `buildFilter`'s facet-exclusion so
 * the badge tells the truth per-card: the ARR-by-region card excludes `region`,
 * so it never claims a region filter it deliberately ignores.
 */
function appliedDimensions(
  selection: Selection,
  exclude?: FilterDimension,
): FilterDimension[] {
  return FILTER_DIMENSIONS.filter(
    (dimension) => dimension !== exclude && selection[dimension] !== undefined,
  );
}

/**
 * Header badge that makes a card explicit about which filters shaped its data.
 * Renders nothing when the card is unfiltered, so an unsliced card stays clean.
 * Placed in `CardAction` (top-right of the header) via the caller.
 */
function FilterBadge({
  selection,
  exclude,
}: {
  selection: Selection;
  exclude?: FilterDimension;
}) {
  const applied = appliedDimensions(selection, exclude);
  if (applied.length === 0) return null;
  return (
    <Badge variant="secondary" className="gap-1">
      <FilterIcon className="size-3" aria-hidden />
      {applied
        .map(
          (dimension) => `${formatLabel(dimension)}: ${selection[dimension]}`,
        )
        .join(" · ")}
    </Badge>
  );
}

/**
 * Loading / error / empty state shared by every visual card. Returns `null`
 * once data has rows so the caller renders the visual.
 *
 * `data === null` means the query hasn't produced a result yet — on first mount
 * `useMetricView` is `loading=false, data=null` for a frame before its effect
 * fires `start()`. Treating that as the skeleton state (not "empty") avoids
 * flashing "No results" before the query has even run. Error is checked first
 * so a failed query still surfaces its message rather than a skeleton.
 */
function VisualStatus({
  loading,
  error,
  data,
}: {
  loading: boolean;
  error: string | null;
  data: readonly unknown[] | null;
}) {
  if (error)
    return (
      <div className="text-destructive text-sm" role="alert">
        {error}
      </div>
    );
  if (loading || data === null) return <Skeleton className="h-64 w-full" />;
  if (data.length === 0)
    return (
      <div className="text-muted-foreground text-sm">
        No results for this selection.
      </div>
    );
  return null;
}

function MetricViewsRoute() {
  // The single source of cross-filter truth. Every visual derives its query
  // filter from this map, and every control (dropdowns, table rows) writes
  // back into it — so all visuals stay coordinated through one piece of state.
  const [selection, setSelection] = useState<Selection>({});

  const setDimension = useCallback(
    (dimension: FilterDimension, value: string | null | undefined) => {
      setSelection((previous) => {
        const next = { ...previous };
        if (value === undefined) delete next[dimension];
        else next[dimension] = value;
        return next;
      });
    },
    [],
  );

  const clearAll = useCallback(() => setSelection({}), []);

  // One filter per visual, each excluding its own grouping dimension so the
  // facet you're slicing on stays fully visible (see buildFilter).
  const regionFilter = useMemo(
    () => buildFilter(selection, "region"),
    [selection],
  );
  const segmentFilter = useMemo(
    () => buildFilter(selection, "segment"),
    [selection],
  );
  // The trend groups by created_at, which isn't a filterable dimension, so it
  // applies the full selection with nothing excluded.
  const trendFilter = useMemo(() => buildFilter(selection), [selection]);

  // Revenue by region — also supplies the Region dropdown's options and the
  // detail table's rows.
  const region = useMetricView("revenue", {
    measures: ARR_MEASURE,
    dimensions: REGION_DIM,
    filter: regionFilter,
  });

  // Revenue by segment — also supplies the Segment dropdown's options.
  const segment = useMetricView("revenue", {
    measures: ARR_MEASURE,
    dimensions: SEGMENT_DIM,
    filter: segmentFilter,
  });

  // ARR + MRR over time — the hero trend.
  const trend = useMetricView("revenue", {
    measures: TREND_MEASURES,
    dimensions: TIME_DIM,
    timeGrain: "month",
    timeDimension: "created_at",
    filter: trendFilter,
  });

  // Detail table, grouped by region. Shares the region bar's filter, so
  // clicking a row narrows the other visuals without hiding the row you clicked.
  const table = useMetricView("revenue", {
    measures: TABLE_MEASURES,
    dimensions: REGION_DIM,
    filter: regionFilter,
  });

  // Dropdown option domains, derived from the region/segment breakdowns. A NULL
  // group key is preserved as `null` (not stringified to "null") so selecting it
  // compiles to `IS NULL` rather than an `equals 'null'` that matches nothing.
  const regionOptions = useMemo(
    () => toDimensionOptions(region.data, "region"),
    [region.data],
  );
  const segmentOptions = useMemo(
    () => toDimensionOptions(segment.data, "segment"),
    [segment.data],
  );

  const activeDimensions = FILTER_DIMENSIONS.filter(
    (dimension) => selection[dimension] !== undefined,
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1100px] mx-auto px-6 py-12">
        <Header
          title="Metric Views"
          description="Cross-filter a governed Unity Catalog metric view with useMetricView — pick a region or segment (or click a table row) and every visual re-queries through a single MetricFilter, with labels + number formats sourced from server-injected metadata."
          tooltip="Each visual POSTs {measures, dimensions, filter} to /api/analytics/metric/revenue. Selections compose into a MetricFilter the server renders into a parameterized WHERE — the client never builds SQL."
        />

        {/* Filter bar: dropdowns write into the shared selection. The Region
            value is bound to selection.region, so it also reflects a table-row
            click below. */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Filters</CardTitle>
            <CardDescription>
              Slice every visual on this page by region and segment.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Select
                value={
                  selection.region === undefined
                    ? ALL
                    : toItemValue(selection.region)
                }
                onValueChange={(value) =>
                  setDimension("region", fromItemValue(value))
                }
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="All regions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All regions</SelectItem>
                  {regionOptions.map((value) => (
                    <SelectItem
                      key={toItemValue(value)}
                      value={toItemValue(value)}
                    >
                      {toDisplayLabel(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={
                  selection.segment === undefined
                    ? ALL
                    : toItemValue(selection.segment)
                }
                onValueChange={(value) =>
                  setDimension("segment", fromItemValue(value))
                }
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="All segments" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All segments</SelectItem>
                  {segmentOptions.map((value) => (
                    <SelectItem
                      key={toItemValue(value)}
                      value={toItemValue(value)}
                    >
                      {toDisplayLabel(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Active-filter chips — click to remove one, or clear all. */}
            {activeDimensions.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {activeDimensions.map((dimension) => (
                  // `asChild` renders the Badge as a real <button> so it's
                  // tab-reachable and Enter/Space-operable, with an explicit
                  // label since the ✕ glyph is decorative.
                  <Badge key={dimension} asChild variant="secondary">
                    <button
                      type="button"
                      className="cursor-pointer"
                      aria-label={`Remove ${formatLabel(dimension)} filter`}
                      onClick={() => setDimension(dimension, undefined)}
                    >
                      {formatLabel(dimension)}:{" "}
                      {toDisplayLabel(selection[dimension] ?? null)}
                      <span aria-hidden className="ml-1">
                        ✕
                      </span>
                    </button>
                  </Badge>
                ))}
                <Button variant="ghost" size="sm" onClick={clearAll}>
                  Clear all
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Revenue by region */}
          <Card>
            <CardHeader>
              <CardTitle>ARR by region</CardTitle>
              <CardDescription>
                revenue · arr · grouped by region
              </CardDescription>
              <CardAction>
                {/* Excludes `region` — same facet-exclusion as this card's
                    filter, so it never claims the region slice it ignores. */}
                <FilterBadge selection={selection} exclude="region" />
              </CardAction>
            </CardHeader>
            <CardContent>
              <VisualStatus
                loading={region.loading}
                error={region.error}
                data={region.data}
              />
              {!region.loading &&
                !region.error &&
                region.data &&
                region.data.length > 0 && (
                  <BarChart
                    data={region.data}
                    xKey="region"
                    yKey="arr"
                    height={280}
                    onDataClick={(d) =>
                      setDimension("region", fromChartName(d.name))
                    }
                    selected={selection.region ?? undefined}
                  />
                )}
            </CardContent>
          </Card>

          {/* Revenue by segment */}
          <Card>
            <CardHeader>
              <CardTitle>ARR by segment</CardTitle>
              <CardDescription>
                revenue · arr · grouped by segment
              </CardDescription>
              <CardAction>
                <FilterBadge selection={selection} exclude="segment" />
              </CardAction>
            </CardHeader>
            <CardContent>
              <VisualStatus
                loading={segment.loading}
                error={segment.error}
                data={segment.data}
              />
              {!segment.loading &&
                !segment.error &&
                segment.data &&
                segment.data.length > 0 && (
                  <DonutChart
                    data={segment.data}
                    xKey="segment"
                    yKey="arr"
                    height={280}
                    innerRadius={55}
                    showLegend
                    onDataClick={(d) =>
                      setDimension("segment", fromChartName(d.name))
                    }
                    selected={selection.segment ?? undefined}
                  />
                )}
            </CardContent>
          </Card>
        </div>

        {/* Hero trend — reshapes as filters narrow. */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Recurring revenue over time</CardTitle>
            <CardDescription>
              revenue · measures {TREND_MEASURES.join(", ")} · grouped by month
            </CardDescription>
            <CardAction>
              {/* No `exclude` — the trend groups by time, so it applies the
                  full selection (both region and segment narrow it). */}
              <FilterBadge selection={selection} />
            </CardAction>
          </CardHeader>
          <CardContent>
            <VisualStatus
              loading={trend.loading}
              error={trend.error}
              data={trend.data}
            />
            {!trend.loading &&
              !trend.error &&
              trend.data &&
              trend.data.length > 0 && (
                <LineChart
                  data={trend.data}
                  xKey="created_at"
                  yKey={[...TREND_MEASURES]}
                  height={320}
                  showLegend
                  onDataClick={(datum) => {
                    console.log("[Metric Views] Line chart clicked", datum);
                  }}
                />
              )}
          </CardContent>
        </Card>

        {/* Detail table: click a row to cross-filter by that region. */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Revenue detail by region</CardTitle>
            <CardDescription>
              Click a row to filter every visual by that region — click again
              (or a chip above) to clear.
            </CardDescription>
            <CardAction>
              {/* Grouped by region, so it excludes `region` (same as the region
                  bar) — a segment filter still narrows it. */}
              <FilterBadge selection={selection} exclude="region" />
            </CardAction>
          </CardHeader>
          <CardContent>
            <VisualStatus
              loading={table.loading}
              error={table.error}
              data={table.data}
            />
            {!table.loading &&
              !table.error &&
              table.data &&
              table.data.length > 0 && (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {TABLE_COLUMNS.map((column) => (
                          <TableHead key={column}>
                            {formatLabel(column, table.metadata?.[column])}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {/* One row per region — region is the GROUP BY key, so
                          it's unique per row and safe as the React key. */}
                      {table.data.map((row) => {
                        // Keep a NULL group key as `null` so selecting the row
                        // filters on `IS NULL`; `String(row.region)` would build
                        // an `equals 'null'` that matches no row.
                        const rowRegion =
                          row.region === null || row.region === undefined
                            ? null
                            : String(row.region);
                        const isSelected = selection.region === rowRegion;
                        const toggle = () =>
                          setDimension(
                            "region",
                            isSelected ? undefined : rowRegion,
                          );
                        return (
                          // The <tr> keeps its native `row` role (no role
                          // override — that would break table semantics for
                          // screen readers); its onClick is a mouse-only
                          // convenience. The real keyboard-accessible control is
                          // the button in the region cell below.
                          <TableRow
                            key={toItemValue(rowRegion)}
                            data-state={isSelected ? "selected" : undefined}
                            className="cursor-pointer hover:bg-muted/50 data-[state=selected]:bg-muted"
                            onClick={toggle}
                          >
                            {TABLE_COLUMNS.map((column) =>
                              column === "region" ? (
                                <TableCell key={column}>
                                  <button
                                    type="button"
                                    aria-pressed={isSelected}
                                    className="text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                                    // Stop propagation so activating the button
                                    // doesn't also fire the row's onClick and
                                    // toggle twice (net no-op).
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      toggle();
                                    }}
                                  >
                                    {formatValue(
                                      row[column],
                                      table.metadata?.[column]?.format,
                                    )}
                                  </button>
                                </TableCell>
                              ) : (
                                <TableCell key={column}>
                                  {formatValue(
                                    row[column],
                                    table.metadata?.[column]?.format,
                                  )}
                                </TableCell>
                              ),
                            )}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
