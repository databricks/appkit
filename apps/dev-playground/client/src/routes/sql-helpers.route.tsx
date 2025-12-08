import { sql } from "@databricks/app-kit-ui/js";
import { useAnalyticsQuery } from "@databricks/app-kit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { codeToHtml } from "shiki";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/sql-helpers")({
  component: SqlHelpersRoute,
});

function CodeBlock({
  code,
  lang = "typescript",
}: {
  code: string;
  lang?: string;
}) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    codeToHtml(code, {
      lang,
      theme: "dark-plus",
    }).then(setHtml);
  }, [code, lang]);

  return (
    <div
      className="rounded-md overflow-hidden [&>pre]:m-0 [&>pre]:p-4 [&>pre]:text-sm font-mono"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ResultDisplay({
  data,
  loading,
  error,
}: {
  data: any;
  loading: boolean;
  error: any;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-amber-600">
        <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
        Executing query...
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-red-600 bg-red-50 p-3 rounded-md border border-red-200">
        <span className="font-semibold">Error:</span>{" "}
        {error.message || String(error)}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return <div className="text-gray-500 italic">No results</div>;
  }

  return (
    <div className="bg-emerald-50 border border-emerald-200 rounded-md p-3">
      <div className="text-emerald-700 font-semibold mb-2 flex items-center gap-2">
        <svg
          aria-label="Success checkmark"
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <title>Success checkmark</title>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M5 13l4 4L19 7"
          />
        </svg>
        Query executed successfully
      </div>
      <pre className="text-sm bg-white p-3 rounded border overflow-x-auto">
        {JSON.stringify(data[0], null, 2)}
      </pre>
    </div>
  );
}

function HelperCard({
  title,
  description,
  type,
  children,
  code,
  resultCode,
}: {
  title: string;
  description: string;
  type: string;
  children: React.ReactNode;
  code: string;
  resultCode: string;
}) {
  const [showCode, setShowCode] = useState(false);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <span className="px-2 py-1 bg-slate-800 text-slate-100 text-xs font-mono rounded">
            {type}
          </span>
          <CardTitle className="text-lg">{title}</CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {children}

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowCode(!showCode)}
          >
            {showCode ? "Hide Code" : "Show Code"}
          </Button>
        </div>

        {showCode && (
          <div className="space-y-3">
            <div>
              <div className="text-xs text-gray-500 mb-1 font-medium">
                Usage:
              </div>
              <CodeBlock code={code} />
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1 font-medium">
                Result object:
              </div>
              <CodeBlock code={resultCode} lang="json" />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SqlHelpersRoute() {
  // State for each input type
  const [stringValue, setStringValue] = useState("Hello, Databricks!");
  const [numberValue, setNumberValue] = useState("42");
  const [booleanValue, setBooleanValue] = useState(true);
  const [dateValue, setDateValue] = useState(() => {
    const today = new Date();
    return today.toISOString().split("T")[0];
  });
  const [timestampValue, setTimestampValue] = useState(() => {
    return new Date().toISOString().slice(0, 19);
  });
  const [binaryInput, setBinaryInput] = useState(
    "0x53, 0x70, 0x61, 0x72, 0x6B",
  ); // "Spark" as bytes

  // Parse bytes input (supports: "0x53, 0x70" or "83, 112" or "53 70")
  const binaryBytes = useMemo(() => {
    try {
      const cleaned = binaryInput.replace(/,/g, " ").trim();
      if (!cleaned) return new Uint8Array([]);

      const parts = cleaned.split(/\s+/).filter(Boolean);
      const bytes = parts.map((part) => {
        if (part.startsWith("0x") || part.startsWith("0X")) {
          return parseInt(part, 16);
        }
        return parseInt(part, 10);
      });

      if (bytes.some((b) => Number.isNaN(b) || b < 0 || b > 255)) {
        return new Uint8Array([]);
      }

      return new Uint8Array(bytes);
    } catch {
      return new Uint8Array([]);
    }
  }, [binaryInput]);

  // Build parameters
  const queryParams = useMemo(() => {
    try {
      return {
        stringParam: sql.string(stringValue),
        numberParam: sql.number(Number(numberValue)),
        booleanParam: sql.boolean(booleanValue),
        dateParam: sql.date(dateValue),
        timestampParam: sql.timestamp(`${timestampValue}Z`),
        binaryParam: sql.binary(binaryBytes),
      };
    } catch {
      return null;
    }
  }, [
    stringValue,
    numberValue,
    booleanValue,
    dateValue,
    timestampValue,
    binaryBytes,
  ]);

  const { data, loading, error } = useAnalyticsQuery(
    "sql_helpers_test",
    queryParams ?? {},
  );

  // Helper to show the marker result
  const getMarkerResult = (fn: () => any) => {
    try {
      return JSON.stringify(fn(), null, 2);
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  };

  return (
    <div className="min-h-[calc(100vh-73px)] bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">SQL Helpers</h1>
          <p className="text-base text-gray-500">
            Type-safe parameter helpers for Databricks SQL queries. Test each
            helper interactively and see the generated parameter objects.
          </p>
        </div>

        {/* Live Query Test */}
        <Card className="mb-8 border-2 border-slate-300 bg-white shadow-lg">
          <CardHeader className="bg-slate-800 text-white">
            <CardTitle className="flex items-center gap-3">
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-label="Lightning bolt"
              >
                <title>Lightning bolt</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
              Live Query Test
            </CardTitle>
            <CardDescription className="text-slate-300">
              All parameters below are sent to the SQL warehouse in real-time
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <ResultDisplay data={data} loading={loading} error={error} />
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* STRING */}
          <HelperCard
            title="String"
            description="For text values. Accepts string, number, or boolean."
            type="STRING"
            code={`import { sql } from "@databricks/app-kit-ui/js";

const params = {
  name: sql.string("${stringValue}")
};`}
            resultCode={getMarkerResult(() => sql.string(stringValue))}
          >
            <Input
              value={stringValue}
              onChange={(e) => setStringValue(e.target.value)}
              placeholder="Enter a string value"
              className="font-mono"
            />
          </HelperCard>

          {/* NUMBER */}
          <HelperCard
            title="Number"
            description="For numeric values. Accepts number or numeric string."
            type="NUMERIC"
            code={`import { sql } from "@databricks/app-kit-ui/js";

const params = {
  count: sql.number(${numberValue})
};`}
            resultCode={getMarkerResult(() => sql.number(Number(numberValue)))}
          >
            <Input
              type="number"
              value={numberValue}
              onChange={(e) => setNumberValue(e.target.value)}
              placeholder="Enter a number"
              className="font-mono"
            />
          </HelperCard>

          {/* BOOLEAN */}
          <HelperCard
            title="Boolean"
            description="For true/false values. Accepts boolean, string, or number (0/1)."
            type="BOOLEAN"
            code={`import { sql } from "@databricks/app-kit-ui/js";

const params = {
  isActive: sql.boolean(${booleanValue})
};`}
            resultCode={getMarkerResult(() => sql.boolean(booleanValue))}
          >
            <div className="flex gap-2">
              <Button
                variant={booleanValue ? "default" : "outline"}
                onClick={() => setBooleanValue(true)}
                className="flex-1"
              >
                true
              </Button>
              <Button
                variant={!booleanValue ? "default" : "outline"}
                onClick={() => setBooleanValue(false)}
                className="flex-1"
              >
                false
              </Button>
            </div>
          </HelperCard>

          {/* DATE */}
          <HelperCard
            title="Date"
            description="For date values. Accepts Date object or YYYY-MM-DD string."
            type="DATE"
            code={`import { sql } from "@databricks/app-kit-ui/js";

const params = {
  startDate: sql.date("${dateValue}")
};

// Or with Date object:
const params2 = {
  startDate: sql.date(new Date("${dateValue}"))
};`}
            resultCode={getMarkerResult(() => sql.date(dateValue))}
          >
            <Input
              type="date"
              value={dateValue}
              onChange={(e) => setDateValue(e.target.value)}
              className="font-mono"
            />
          </HelperCard>

          {/* TIMESTAMP */}
          <HelperCard
            title="Timestamp"
            description="For datetime values. Accepts Date, ISO string, or Unix timestamp."
            type="TIMESTAMP"
            code={`import { sql } from "@databricks/app-kit-ui/js";

const params = {
  createdAt: sql.timestamp("${timestampValue}Z")
};

// Or with Date object:
const params2 = {
  createdAt: sql.timestamp(new Date())
};

// Or with Unix timestamp (ms):
const params3 = {
  createdAt: sql.timestamp(${Date.now()})
};`}
            resultCode={getMarkerResult(() =>
              sql.timestamp(`${timestampValue}Z`),
            )}
          >
            <Input
              type="datetime-local"
              value={timestampValue}
              onChange={(e) => setTimestampValue(e.target.value)}
              className="font-mono"
            />
          </HelperCard>

          {/* BINARY */}
          <HelperCard
            title="Binary"
            description="For binary data. Converts to hex-encoded STRING. Use UNHEX(:param) in SQL."
            type="STRING (hex)"
            code={`import { sql } from "@databricks/app-kit-ui/js";

// From Uint8Array:
const bytes = new Uint8Array([${Array.from(binaryBytes)
              .map((b) => `0x${b.toString(16).padStart(2, "0")}`)
              .join(", ")}]);
const params = {
  data: sql.binary(bytes)
};
// Result: { __sql_type: "STRING", value: "${Array.from(binaryBytes)
              .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
              .join("")}" }
// SQL: SELECT UNHEX(:data) as binary_value

// From ArrayBuffer:
const buffer = new Uint8Array([0x48, 0x69]).buffer;
const params2 = {
  data: sql.binary(buffer) // converts to hex "4869"
};

// From hex string directly:
const params3 = {
  data: sql.binary("537061726B") // already hex, just validates
};`}
            resultCode={getMarkerResult(() => sql.binary(binaryBytes))}
          >
            <div className="space-y-2">
              <Input
                value={binaryInput}
                onChange={(e) => setBinaryInput(e.target.value)}
                placeholder="0x53, 0x70, 0x61 or 83, 112, 97"
                className="font-mono"
              />
              <div className="text-xs text-gray-500 space-y-1">
                <div>
                  Uint8Array: [{Array.from(binaryBytes).join(", ")}] (
                  {binaryBytes.length} bytes)
                </div>
                <div>
                  Hex output:{" "}
                  {Array.from(binaryBytes)
                    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
                    .join("") || "(empty)"}
                </div>
                <div>
                  As text: &quot;{(() => {
                    try {
                      return new TextDecoder().decode(binaryBytes);
                    } catch {
                      return "(invalid UTF-8)";
                    }
                  })()}&quot;
                </div>
              </div>
            </div>
          </HelperCard>
        </div>

        {/* Query Reference */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>SQL Query Reference</CardTitle>
            <CardDescription>
              The test query used to validate all parameter types
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CodeBlock
              code={`-- sql_helpers_test.sql
SELECT
  :stringParam as string_value,
  :numberParam as number_value,
  :booleanParam as boolean_value,
  :dateParam as date_value,
  :timestampParam as timestamp_value,
  UNHEX(:binaryParam) as binary_value,  -- Convert hex string to BINARY
  :binaryParam as binary_hex,
  LENGTH(UNHEX(:binaryParam)) as binary_length`}
              lang="sql"
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
