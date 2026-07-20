import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
  Variant,
  Variants,
} from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowRight,
  Boxes,
  Gauge,
  Github,
  Radio,
  Rocket,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

export const Route = createFileRoute("/ui-variants")({
  component: UiVariantsRoute,
});

/**
 * Demo of the `<Variants>` picker: a page composed of two independent
 * `<Variants>` blocks:
 *   - `about-hero` — the top hero section (3 treatments)
 *   - `about-info` — the informational section underneath (3 treatments)
 *
 * Hover either framed block in the browser to reveal the switcher, flip
 * between the variants, and Confirm the one you want. The `/ui` skill then
 * finalizes each chosen variant into source, dropping the wrappers.
 */
function UiVariantsRoute() {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-[1000px] px-6 py-12">
        <Variants blockId="about-hero">
          <Variant label="Centered">
            <section className="flex flex-col items-center px-6 py-20 text-center">
              <Badge variant="secondary" className="mb-6">
                <Sparkles className="size-3.5" /> About AppKit
              </Badge>
              <h1 className="text-5xl font-bold tracking-tight text-foreground">
                Build Databricks apps, not plumbing
              </h1>
              <p className="mt-6 max-w-xl text-lg text-muted-foreground">
                AppKit is a modular TypeScript SDK with a plugin architecture,
                first-class streaming, and built-in observability.
              </p>
              <div className="mt-10 flex gap-3">
                <Button size="lg">
                  Get started <ArrowRight className="size-4" />
                </Button>
                <Button size="lg" variant="outline">
                  <Github className="size-4" /> View source
                </Button>
              </div>
            </section>
          </Variant>

          <Variant label="Split with stats">
            <section className="grid grid-cols-1 items-center gap-10 py-20 md:grid-cols-2">
              <div>
                <Badge variant="secondary" className="mb-4">
                  <Rocket className="size-3.5" /> About AppKit
                </Badge>
                <h1 className="text-4xl font-bold tracking-tight text-foreground">
                  The SDK for Databricks applications
                </h1>
                <p className="mt-4 text-lg text-muted-foreground">
                  A plugin-first toolkit that handles the hard parts — auth,
                  streaming, telemetry — so your team ships features faster.
                </p>
                <div className="mt-8">
                  <Button size="lg">
                    Get started <ArrowRight className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {[
                  { value: "20+", label: "Built-in plugins" },
                  { value: "100%", label: "TypeScript" },
                  { value: "SSE", label: "Streaming-first" },
                  { value: "OTEL", label: "Observability" },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className="rounded-lg border bg-card p-5 text-center"
                  >
                    <div className="text-3xl font-bold text-foreground">
                      {stat.value}
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      {stat.label}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </Variant>

          <Variant label="Minimal">
            <section className="border-b py-16">
              <h1 className="text-4xl font-bold tracking-tight text-foreground">
                About AppKit
              </h1>
              <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
                A modular TypeScript SDK for building Databricks applications
                with a plugin-based architecture, streaming, and observability
                baked in.
              </p>
            </section>
          </Variant>
        </Variants>

        <div className="h-12" />

        <Variants blockId="about-info">
          <Variant label="Feature grid">
            <section className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  icon: Boxes,
                  title: "Plugin-first",
                  body: "Everything is a plugin — compose exactly the capabilities your app needs.",
                },
                {
                  icon: Radio,
                  title: "Streaming-first",
                  body: "Built-in SSE with automatic reconnection and event replay.",
                },
                {
                  icon: Gauge,
                  title: "Observable",
                  body: "OpenTelemetry traces, metrics, and logs wired in from day one.",
                },
                {
                  icon: ShieldCheck,
                  title: "Type-safe",
                  body: "Heavy TypeScript with runtime validation via Zod.",
                },
                {
                  icon: Sparkles,
                  title: "Great DX",
                  body: "HMR, hot-reload, source maps, and inspection tools out of the box.",
                },
                {
                  icon: Rocket,
                  title: "Production-ready",
                  body: "Graceful shutdown, retries, timeouts, and caching interceptors.",
                },
              ].map((feature) => (
                <Card key={feature.title}>
                  <CardHeader>
                    <feature.icon className="size-6 text-primary" />
                    <CardTitle className="mt-2">{feature.title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      {feature.body}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </section>
          </Variant>

          <Variant label="Two column prose">
            <section className="grid grid-cols-1 gap-10 md:grid-cols-3">
              <div className="md:col-span-1">
                <h2 className="text-2xl font-semibold text-foreground">
                  Why AppKit?
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Designed for teams building data and AI apps on Databricks.
                </p>
              </div>
              <div className="space-y-6 md:col-span-2">
                <div>
                  <h3 className="font-medium text-foreground">
                    Modular by design
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    A plugin architecture lets you add analytics, agents,
                    Lakebase, and more without rewiring your app.
                  </p>
                </div>
                <Separator />
                <div>
                  <h3 className="font-medium text-foreground">
                    Built for streaming
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Server-Sent Events with reconnection and per-stream
                    cancellation come standard.
                  </p>
                </div>
                <Separator />
                <div>
                  <h3 className="font-medium text-foreground">
                    Observable and safe
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    OpenTelemetry and Zod validation give you confidence in
                    production.
                  </p>
                </div>
              </div>
            </section>
          </Variant>

          <Variant label="Stat callout">
            <Card>
              <CardHeader>
                <CardTitle>What AppKit gives you</CardTitle>
                <CardDescription>
                  The essentials for shipping Databricks apps quickly.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
                  {[
                    {
                      value: "Plugins",
                      body: "Compose analytics, agents, files, and more.",
                    },
                    {
                      value: "Streaming",
                      body: "SSE with reconnection built in.",
                    },
                    {
                      value: "Telemetry",
                      body: "OpenTelemetry traces and metrics.",
                    },
                  ].map((item) => (
                    <div key={item.value}>
                      <div className="text-lg font-semibold text-foreground">
                        {item.value}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {item.body}
                      </p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </Variant>
        </Variants>
      </div>
    </div>
  );
}
