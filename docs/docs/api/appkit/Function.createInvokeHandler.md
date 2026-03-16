# Function: createInvokeHandler()

```ts
function createInvokeHandler(getAgent: () => AgentInterface): RequestHandler;
```

Create an Express handler that invokes the agent via the AgentInterface
and streams/returns the response in Responses API format.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `getAgent` | () => [`AgentInterface`](Interface.AgentInterface.md) |

## Returns

`RequestHandler`
