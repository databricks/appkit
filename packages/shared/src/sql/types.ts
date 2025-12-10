export interface SQLStringMarker {
  __sql_type: "STRING";
  value: string;
}

export interface SQLNumberMarker {
  __sql_type: "NUMERIC";
  value: string;
}

export interface SQLBooleanMarker {
  __sql_type: "BOOLEAN";
  value: string;
}

/**  SQL Binary marker is a STRING with hex encoding */
export interface SQLBinaryMarker {
  __sql_type: "STRING";
  value: string;
}

export interface SQLDateMarker {
  __sql_type: "DATE";
  value: string;
}

export interface SQLTimestampMarker {
  __sql_type: "TIMESTAMP";
  value: string;
}

/**
 * Object that identifies a typed SQL parameter.
 * Created using sql.date(), sql.string(), sql.number(), sql.boolean(), sql.timestamp(), sql.binary(), or sql.interval().
 */
export type SQLTypeMarker =
  | SQLStringMarker
  | SQLNumberMarker
  | SQLBooleanMarker
  | SQLBinaryMarker
  | SQLDateMarker
  | SQLTimestampMarker;
