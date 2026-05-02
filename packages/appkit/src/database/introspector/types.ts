export type CascadeAction = "cascade" | "set null" | "restrict" | "no action";

export interface IntrospectedColumn {
  name: string;
  pgType: string;
  nullable: boolean;
  hasDefault: boolean;
  defaultExpression?: string;
  isPrimaryKey?: boolean;
  serverGenerated?: boolean;
  references?: {
    schema: string;
    table: string;
    column: string;
    onDelete?: CascadeAction;
    onUpdate?: CascadeAction;
  };
}

export interface IntrospectedPolicy {
  name: string;
  permissive: boolean;
  for: ("select" | "insert" | "update" | "delete")[];
  roles: string[];
  using?: string;
  withCheck?: string;
}

export interface IntrospectedTable {
  schema: string;
  name: string;
  columns: IntrospectedColumn[];
  policies: IntrospectedPolicy[];
  readonly?: boolean;
}

export interface IntrospectionResult {
  schemas: string[];
  tables: IntrospectedTable[];
}
