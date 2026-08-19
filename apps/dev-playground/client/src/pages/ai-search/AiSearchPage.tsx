import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
} from "@databricks/appkit-ui/react";
import { useAiSearchQuery } from "@databricks/appkit-ui/react/beta";
import { Search } from "lucide-react";
import { useState } from "react";

import { Header } from "@/components/layout/header";

export function AiSearchPage() {
  const [query, setQuery] = useState("");
  const { search, data, loading, error } = useAiSearchQuery({ alias: "demo" });

  const handleSearch = () => {
    if (query.trim()) void search(query);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSearch();
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-4xl mx-auto px-6 py-12">
        <Header
          title="AI Search"
          description="Query a Databricks AI Search index with hybrid search."
          tooltip="Uses the AI Search plugin to query a Databricks Vector Search index via the REST API"
        />

        <div className="flex flex-col gap-6">
          <div className="flex gap-3">
            <Input
              placeholder="Enter a search query..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1"
            />
            <Button onClick={handleSearch} disabled={loading || !query.trim()}>
              {loading ? (
                "Searching..."
              ) : (
                <>
                  <Search className="h-4 w-4 mr-2" />
                  Search
                </>
              )}
            </Button>
          </div>

          {error && (
            <div className="rounded-md border border-destructive bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {data && (
            <div className="flex flex-col gap-4">
              <div className="text-sm text-muted-foreground">
                {data.totalCount} result
                {data.totalCount !== 1 ? "s" : ""} &middot; {data.queryTimeMs}ms
                &middot; {data.queryType}
              </div>

              {data.results.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No results found.
                </p>
              ) : (
                data.results.map((result, index) => (
                  <Card key={`${result.score}-${index}`}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium flex items-center justify-between">
                        <span>Result {index + 1}</span>
                        <span className="text-muted-foreground font-normal">
                          score: {result.score.toFixed(4)}
                        </span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <dl className="grid grid-cols-1 gap-1">
                        {Object.entries(result.data).map(([key, value]) => (
                          <div key={key} className="flex gap-2 text-sm">
                            <dt className="font-medium text-muted-foreground min-w-[80px] shrink-0">
                              {key}
                            </dt>
                            <dd className="text-foreground break-all">
                              {String(value ?? "")}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
