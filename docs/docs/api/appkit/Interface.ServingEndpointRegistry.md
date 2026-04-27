# Interface: ServingEndpointRegistry

Registry interface for serving endpoint type generation.
Empty by default — augmented by the Vite type generator's `.d.ts` output via module augmentation.
When populated, provides autocomplete for alias names and typed request/response/chunk per endpoint.
