# Type Alias: ServingFactory

```ts
type ServingFactory = keyof ServingEndpointRegistry extends never ? (alias?: string) => ServingEndpointMethods : <K>(alias: K) => ServingEndpointMethods<ServingEndpointRegistry[K]["request"], ServingEndpointRegistry[K]["response"], ServingEndpointRegistry[K]["chunk"]>;
```

Factory function type — typed when registry is populated, untyped fallback otherwise.
