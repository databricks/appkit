import { Badge, Card } from "@databricks/appkit-ui/react";
import {
  createFileRoute,
  Link,
  retainSearchParams,
} from "@tanstack/react-router";
import { ArrowRightIcon, SparklesIcon } from "lucide-react";
import { ThemeSelector } from "@/components/theme-selector";
import { ALL_NAV_ITEMS, NAV_GROUPS, type NavItem } from "@/lib/nav";

export const Route = createFileRoute("/")({
  component: IndexRoute,
  search: {
    middlewares: [retainSearchParams(true)],
  },
});

/**
 * Landing page for the dev playground. Renders a hero and the canonical
 * demo catalog grouped by category (Data / AI / Platform).
 *
 * The catalog itself lives in `@/lib/nav.ts` and is shared with the nav
 * dropdown in `__root.tsx`, so adding a new demo is a one-line change that
 * updates both surfaces at once.
 */
function IndexRoute() {
  return (
    <div className="min-h-screen bg-background">
      <div className="absolute top-4 right-4 z-10">
        <ThemeSelector />
      </div>

      <Hero demoCount={ALL_NAV_ITEMS.length} />

      <div className="max-w-6xl mx-auto px-6 pb-20">
        <div className="space-y-14">
          {NAV_GROUPS.map((group) => (
            <section key={group.id} aria-labelledby={`group-${group.id}`}>
              <div className="mb-5">
                <h2
                  id={`group-${group.id}`}
                  className="text-2xl font-semibold tracking-tight text-foreground"
                >
                  {group.label}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {group.tagline}
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {group.items.map((item) => (
                  <DemoCard key={item.to} item={item} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <footer className="mt-20 pt-8 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
          <span>Built by Databricks with AppKit.</span>
          <span className="tabular-nums">
            {ALL_NAV_ITEMS.length} demos · {NAV_GROUPS.length} categories
          </span>
        </footer>
      </div>
    </div>
  );
}

function Hero({ demoCount }: { demoCount: number }) {
  return (
    <div className="relative overflow-hidden">
      {/*
        Soft radial wash behind the hero. Two layered gradients (primary +
        accent) at ~10% opacity give depth without the "AI slop" look of a
        full-saturation banner. `pointer-events-none` keeps the theme selector
        above clickable.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 80% 50% at 50% 0%, hsl(var(--primary) / 0.08), transparent 60%), radial-gradient(ellipse 60% 40% at 80% 20%, hsl(var(--accent) / 0.06), transparent 60%)",
        }}
      />
      <div className="relative max-w-6xl mx-auto px-6 pt-24 pb-16 text-center">
        <Badge
          variant="outline"
          className="mb-6 gap-1.5 px-3 py-1 text-xs font-medium"
        >
          <SparklesIcon className="h-3 w-3" />
          {demoCount} interactive demos
        </Badge>
        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight text-foreground mb-5">
          AppKit Playground
        </h1>
        <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          A living catalog of what AppKit can do — data, agents, and platform
          primitives, each wired up as a single-click demo you can poke at,
          copy, or break.
        </p>
      </div>
    </div>
  );
}

function DemoCard({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className="no-underline text-inherit group block"
      aria-label={`Open ${item.label} demo`}
    >
      <Card className="h-full p-5 transition-all duration-200 border hover:border-primary/30 hover:shadow-md">
        <div className="flex items-start gap-3 mb-3">
          <div className="shrink-0 rounded-lg bg-muted p-2 text-foreground group-hover:bg-primary/10 group-hover:text-primary transition-colors">
            <Icon className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-foreground tracking-tight leading-tight">
              {item.label}
            </h3>
          </div>
          <ArrowRightIcon className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {item.description}
        </p>
      </Card>
    </Link>
  );
}
