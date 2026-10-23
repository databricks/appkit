# Function: definePolicy()

## Call Signature

```ts
function definePolicy<In>(policy: AllowPolicy<In>): AllowPolicy<In>;
```

Declare a reusable authorization rule. Without `resource` it decides from
the actor and input. With `resource` it loads one record first; annotate
the lookup context to fix the input the policy needs. `allow` may return
`true`, `false`, or `{ deny }`.

### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `In` | `unknown` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `policy` | `AllowPolicy`\<`In`\> |

### Returns

`AllowPolicy`\<`In`\>

## Call Signature

```ts
function definePolicy<In, R>(policy: ResourcePolicy<In, R>): ResourcePolicy<In, R>;
```

Declare a reusable authorization rule. Without `resource` it decides from
the actor and input. With `resource` it loads one record first; annotate
the lookup context to fix the input the policy needs. `allow` may return
`true`, `false`, or `{ deny }`.

### Type Parameters

| Type Parameter |
| ------ |
| `In` |
| `R` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `policy` | `ResourcePolicy`\<`In`, `R`\> |

### Returns

`ResourcePolicy`\<`In`, `R`\>
