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
  notify,
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

// The dimensions the page lets you slice by. Both the filter bar (dropdowns)
// and the detail table (row click) write selections keyed by these names, and
// every visual composes them into a `MetricFilter` the same way — so a future
// chart-click cross-filter drops into the same `selection` state unchanged.
const FILTER_DIMENSIONS = ["region", "segment"] as const;
type FilterDimension = (typeof FILTER_DIMENSIONS)[number];
type Selection = Partial<Record<FilterDimension, string>>;

// Radix `Select` forbids an empty-string item value, so an explicit sentinel
// stands in for the "no filter on this dimension" choice.
const ALL = "__all__";

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
  const shorthand: Record<string, string> = {};
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
    (dimension: FilterDimension, value: string | undefined) => {
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
  // The trend and table group by created_at / region respectively; neither is a
  // filterable dimension in its own right for the trend, so it applies the full
  // selection. The table groups by region, so it excludes region (same filter
  // as the region bar).
  const trendFilter = useMemo(() => buildFilter(selection), [selection]);

  // Revenue by region — the filter excludes `region`, so this always lists
  // every region available under the current segment selection. Doubles as the
  // domain for the Region dropdown and the detail table below.
  const region = useMetricView("revenue", {
    measures: ARR_MEASURE,
    dimensions: REGION_DIM,
    filter: regionFilter,
  });

  // Revenue by segment — excludes `segment`, so every segment stays visible and
  // this also feeds the Segment dropdown's options.
  const segment = useMetricView("revenue", {
    measures: ARR_MEASURE,
    dimensions: SEGMENT_DIM,
    filter: segmentFilter,
  });

  // ARR + MRR over time — the hero trend. Applies the full selection, so
  // picking a region and/or segment visibly reshapes the line.
  const trend = useMetricView("revenue", {
    measures: TREND_MEASURES,
    dimensions: TIME_DIM,
    timeGrain: "month",
    timeDimension: "created_at",
    filter: trendFilter,
  });

  // Detail table, grouped by region. Same filter as the region bar (excludes
  // region) so clicking a row narrows the other visuals without hiding the row
  // you just clicked. This is the table cross-filter.
  const table = useMetricView("revenue", {
    measures: TABLE_MEASURES,
    dimensions: REGION_DIM,
    filter: regionFilter,
  });

  // Dropdown option domains, derived from the region/segment breakdowns. Because
  // each breakdown excludes its own dimension's filter, the options reflect
  // what's actually available under the *other* active filter.
  const regionOptions = useMemo(
    () =>
      Array.from(
        new Set((region.data ?? []).map((row) => String(row.region))),
      ).sort(),
    [region.data],
  );
  const segmentOptions = useMemo(
    () =>
      Array.from(
        new Set((segment.data ?? []).map((row) => String(row.segment))),
      ).sort(),
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

        {/* Filter bar (A): dropdowns write into the shared selection. The Region
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
                value={selection.region ?? ALL}
                onValueChange={(value) =>
                  setDimension("region", value === ALL ? undefined : value)
                }
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="All regions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All regions</SelectItem>
                  {regionOptions.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={selection.segment ?? ALL}
                onValueChange={(value) =>
                  setDimension("segment", value === ALL ? undefined : value)
                }
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="All segments" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All segments</SelectItem>
                  {segmentOptions.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
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
                      {formatLabel(dimension)}: {selection[dimension]}
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
                    onDataClick={(d) => setDimension("region", d.name)}
                    selected={selection.region}
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
                    onDataClick={(d) => setDimension("segment", d.name)}
                    selected={selection.segment}
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
                  // Render point symbols + trigger clicks along the whole line
                  // (SDK's triggerLineEvent, on because onDataClick is set) so
                  // the hairline isn't the only hit target.
                  showSymbol
                  // Clicking a point fires a transient "write-back" toast (the
                  // "Apps = action layer" gesture) through the same Toaster the
                  // warehouse-status indicator uses.
                  onDataClick={(d) => {
                    // Resolve the measure by series INDEX — yKey order ===
                    // TREND_MEASURES order, and sorting only reorders points
                    // WITHIN a series, not the series array. (Parsing the "Arr"
                    // label wouldn't round-trip to keys like "new_arr", and
                    // indexing trend.data by dataIndex is wrong because the
                    // time series is sorted before rendering.)
                    const measureKey = TREND_MEASURES[d.seriesIndex];
                    if (!measureKey) return;
                    const meta = trend.metadata?.[measureKey];
                    const label = meta?.display_name ?? measureKey;
                    // A time-series point is a [epochMs, value] tuple on
                    // ECharts' params.value (d.value is null for tuples); read
                    // it off the raw params so both the date and amount survive.
                    const tuple = (d.raw as { value?: unknown } | undefined)
                      ?.value;
                    const [ts, amount] = Array.isArray(tuple)
                      ? tuple
                      : [undefined, undefined];
                    const month =
                      typeof ts === "number"
                        ? new Date(ts).toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                          })
                        : String(d.name || "");
                    const formatted = formatValue(amount, meta?.format);
                    notify.message(
                      `Write back: ${label} · ${month} · ${formatted}`,
                      { description: "Point selected for write-back (demo)." },
                    );
                  }}
                />
              )}
          </CardContent>
        </Card>

        {/* Detail table (C): click a row to cross-filter by that region. */}
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
                        const rowRegion = String(row.region);
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
                            key={rowRegion}
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
