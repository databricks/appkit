# Type Alias: SupervisorTool

```ts
type SupervisorTool = 
  | {
  genie_space: {
     description: string;
     id: string;
  };
  type: "genie_space";
}
  | {
  type: "uc_function";
  uc_function: {
     description: string;
     name: string;
  };
}
  | {
  knowledge_assistant: {
     description: string;
     knowledge_assistant_id: string;
  };
  type: "knowledge_assistant";
}
  | {
  app: {
     description: string;
     name: string;
  };
  type: "app";
}
  | {
  type: "uc_connection";
  uc_connection: {
     description: string;
     name: string;
  };
};
```

Tools supported by the Databricks AI Gateway Responses API. The shapes match
the wire format the endpoint expects, so the adapter passes the array
straight into the request body.

This is an adapter-internal wire type. Application code authors tools via
the [supervisorTools](Variable.supervisorTools.md) factories, which return tagged
[HostedSupervisorTool](Interface.HostedSupervisorTool.md) records — the agents plugin then unwraps
the `.spec` when routing through [AgentInput.extensions](Interface.AgentInput.md#extensions).
