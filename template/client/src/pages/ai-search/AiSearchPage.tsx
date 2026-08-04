{{if .plugins.aiSearch -}}
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Skeleton,
  useAiSearchQuery,
} from '@databricks/appkit-ui/react';
import { Search } from 'lucide-react';
import { useState } from 'react';

export function AiSearchPage() {
  const [query, setQuery] = useState('');
  // Queries the first configured index. Pass `{ alias }` to target another.
  const { search, data, loading, error } = useAiSearchQuery();

  const handleSearch = () => {
    if (query.trim()) void search(query);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSearch();
  };

  return (
    <div className="space-y-6 w-full max-w-4xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold text-foreground">AI Search</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Query a Databricks AI Search index using natural language.
        </p>
      </div>

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
            'Searching...'
          ) : (
            <>
              <Search className="h-4 w-4 mr-2" />
              Search
            </>
          )}
        </Button>
      </div>

      {error && (
        <div className="text-destructive bg-destructive/10 p-3 rounded-md text-sm">
          {error}
        </div>
      )}

      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={`skeleton-${i}`}>
              <CardContent className="pt-4 space-y-2">
                <Skeleton className="h-4 w-1/4" />
                <Skeleton className="h-4 w-3/4" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {data && !loading && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {data.totalCount} result{data.totalCount !== 1 ? 's' : ''} &middot;{' '}
            {data.queryTimeMs}ms &middot; {data.queryType}
          </p>

          {data.results.length === 0 ? (
            <p className="text-sm text-muted-foreground">No results found.</p>
          ) : (
            data.results.map((result, index) => (
              <Card key={index} className="shadow-sm">
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
                          {String(value ?? '')}
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
  );
}
{{- end}}
