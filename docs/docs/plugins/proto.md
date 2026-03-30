---
sidebar_position: 8
---

# Proto plugin

Typed data contracts via protobuf. Define your data shapes once in `.proto` files, generate TypeScript types, and use them across plugins, routes, and jobs — no more ad-hoc interfaces that drift between producer and consumer.

**Key features:**
- **Single schema definition** — one `.proto` file generates types for all consumers
- **Binary + JSON serialization** — efficient binary for storage, JSON for APIs
- **Type-safe create** — construct messages with compile-time field validation
- **Interop with other plugins** — serialize to bytes, pass to Files plugin for Volume I/O; serialize to JSON, pass to Analytics plugin for SQL; serialize to binary, send over gRPC

## Basic usage

```ts
import { createApp, proto, server } from "@databricks/appkit";

const app = await createApp({
  plugins: [
    server(),
    proto(),
  ],
});
```

## Defining contracts

Create `.proto` files in your project:

```protobuf
// proto/myapp/v1/models.proto
syntax = "proto3";
package myapp.v1;

message Customer {
  string id = 1;
  string name = 2;
  string email = 3;
  double lifetime_value = 4;
  bool is_active = 5;
}

message Order {
  string order_id = 1;
  string customer_id = 2;
  double total = 3;
  repeated OrderItem items = 4;
}

message OrderItem {
  string product_id = 1;
  string name = 2;
  int32 quantity = 3;
  double unit_price = 4;
}
```

Generate TypeScript types:

```bash
npx buf generate proto/
```

This produces typed interfaces like `Customer`, `Order`, `OrderItem` with schemas like `CustomerSchema`, `OrderSchema`.

## Creating messages

```ts
import { CustomerSchema } from "../proto/gen/myapp/v1/models_pb.js";

// Type-safe — unknown fields are compile errors
const customer = app.proto.create(CustomerSchema, {
  id: "cust-001",
  name: "Acme Corp",
  email: "billing@acme.com",
  lifetimeValue: 15_230.50,
  isActive: true,
});
```

## Serialization

### Binary (compact, for storage and transfer)

```ts
const bytes = app.proto.serialize(CustomerSchema, customer);
// bytes: Uint8Array — pass to Files plugin, store in database, send over network

const recovered = app.proto.deserialize(CustomerSchema, bytes);
// recovered.name === "Acme Corp"
```

### JSON (human-readable, for APIs and logging)

```ts
const json = app.proto.toJSON(CustomerSchema, customer);
// { "id": "cust-001", "name": "Acme Corp", "email": "billing@acme.com",
//   "lifetimeValue": 15230.5, "isActive": true }

const fromApi = app.proto.fromJSON(CustomerSchema, requestBody);
```

## Combining with other plugins

### Proto + Files: typed Volume I/O

```ts
import { createApp, proto, files, server } from "@databricks/appkit";

const app = await createApp({
  plugins: [server(), proto(), files()],
});

// Serialize a message and upload to a UC Volume
const bytes = app.proto.serialize(OrderSchema, order);
await app.files("reports").upload("orders/latest.bin", Buffer.from(bytes));

// Download and deserialize
const data = await app.files("reports").download("orders/latest.bin");
const loaded = app.proto.deserialize(OrderSchema, new Uint8Array(data));
```

### Proto + Lakebase: typed database rows

```ts
import { createApp, proto, lakebase, server } from "@databricks/appkit";

const app = await createApp({
  plugins: [server(), proto(), lakebase()],
});

// Convert proto message to JSON for SQL insert
const json = app.proto.toJSON(CustomerSchema, customer);
await app.lakebase.query(
  `INSERT INTO customers (id, name, email, lifetime_value, is_active)
   VALUES ($1, $2, $3, $4, $5)`,
  [json.id, json.name, json.email, json.lifetimeValue, json.isActive],
);
```

### Proto + Analytics: typed query results

```ts
// Parse SQL query results into typed proto messages
const rows = await app.analytics.query("top-customers", { minValue: 1000 });
const customers = rows.map((row) =>
  app.proto.fromJSON(CustomerSchema, row),
);
```

## API routes with typed contracts

```ts
import express from "express";

app.server.extend((expressApp) => {
  expressApp.get("/api/customers/:id", async (req, res) => {
    const row = await app.lakebase.query(
      "SELECT * FROM customers WHERE id = $1",
      [req.params.id],
    );
    if (!row.length) return res.status(404).json({ error: "Not found" });

    // Parse to proto and back to JSON — guarantees the response
    // matches the contract even if the DB has extra columns
    const customer = app.proto.fromJSON(CustomerSchema, row[0]);
    res.json(app.proto.toJSON(CustomerSchema, customer));
  });

  expressApp.post("/api/orders", express.json(), async (req, res) => {
    // Validate request body against the proto schema
    const order = app.proto.fromJSON(OrderSchema, req.body);
    // order is now typed — order.items, order.total, etc.

    const bytes = app.proto.serialize(OrderSchema, order);
    await app.files("orders").upload(
      `${order.orderId}.bin`,
      Buffer.from(bytes),
    );

    res.status(201).json(app.proto.toJSON(OrderSchema, order));
  });
});
```

## Proto setup with buf

Install buf and protoc-gen-es:

```bash
pnpm add -D @bufbuild/buf @bufbuild/protoc-gen-es @bufbuild/protobuf
```

Create `proto/buf.yaml`:

```yaml
version: v2
modules:
  - path: .
lint:
  use:
    - STANDARD
```

Create `proto/buf.gen.yaml`:

```yaml
version: v2
plugins:
  - local: protoc-gen-es
    out: proto/gen
    opt:
      - target=ts
```

Generate types:

```bash
npx buf generate proto/
```

Add to your build:

```json
{
  "scripts": {
    "proto:generate": "buf generate proto/",
    "proto:lint": "buf lint proto/",
    "prebuild": "pnpm proto:generate"
  }
}
```

## API reference

| Method | Description |
| --- | --- |
| `create(schema, init?)` | Create a new proto message with optional initial values |
| `serialize(schema, message)` | Serialize to binary (`Uint8Array`) |
| `deserialize(schema, data)` | Deserialize from binary |
| `toJSON(schema, message)` | Convert to JSON (snake_case field names) |
| `fromJSON(schema, json)` | Parse from JSON |

## Configuration

The proto plugin requires no configuration:

```ts
proto()  // That's it
```
