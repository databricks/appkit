# Type Alias: ServingFactory

```ts
type ServingFactory = keyof ServingEndpointRegistry extends never ? (alias?: string) => ServingEndpointHandle : true extends IsUnion<keyof ServingEndpointRegistry> ? <K>(alias: K) => ServingEndpointHandle<ServingEndpointRegistry[K]["request"], ServingEndpointRegistry[K]["response"]> : {
<K>  (alias: K): ServingEndpointHandle<ServingEndpointRegistry[K]["request"], ServingEndpointRegistry[K]["response"]>;
  (): ServingEndpointHandle<never, never>;
};
```

Factory function returned by `AppKit.serving`.

Adapts based on the `ServingEndpointRegistry` state:

- **Empty (default):** `(alias?: string) => ServingEndpointHandle` — any string, untyped.
- **Single key:** alias optional — `serving()` returns the typed handle for the only endpoint.
- **Multiple keys:** alias required — must specify which endpoint.

Run `appKitServingTypesPlugin()` in your Vite config to generate the registry.
