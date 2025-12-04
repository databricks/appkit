import { describe, expect, it } from "vitest";
import { isSQLTypeMarker, sql } from "../helpers";

describe("SQL Helpers", () => {
  describe("date()", () => {
    it("should create a DATE type parameter from a Date object", () => {
      const date = new Date("2024-01-01");
      const result = sql.date(date);
      expect(result).toEqual({
        __sql_type: "DATE",
        value: "2024-01-01",
      });
    });

    it("should create a DATE type parameter from an ISO date string", () => {
      const date = "2024-01-01";
      const result = sql.date(date);
      expect(result).toEqual({
        __sql_type: "DATE",
        value: "2024-01-01",
      });
    });

    it("should reject invalid date format", () => {
      const date = "01/01/2024";
      expect(() => sql.date(date)).toThrow(
        "sql.date() expects Date or ISO date string (YYYY-MM-DD format), got: 01/01/2024",
      );
    });

    it("should reject invalid date value", () => {
      const date = 1234567890;
      expect(() => sql.date(date as any)).toThrow(
        "sql.date() expects Date or ISO date string (YYYY-MM-DD format), got: number",
      );
    });
  });

  describe("number()", () => {
    it("should create a NUMERIC type parameter from a number", () => {
      const number = 1234567890;
      const result = sql.number(number);
      expect(result).toEqual({
        __sql_type: "NUMERIC",
        value: "1234567890",
      });
    });

    it("should create a NUMERIC type parameter from a numeric string", () => {
      const number = "1234567890";
      const result = sql.number(number);
      expect(result).toEqual({
        __sql_type: "NUMERIC",
        value: "1234567890",
      });
    });

    it("should reject non-numeric string", () => {
      const number = "hello";
      expect(() => sql.number(number as any)).toThrow(
        "sql.number() expects number or numeric string, got: hello",
      );
    });

    it("should reject empty string", () => {
      expect(() => sql.number("")).toThrow(
        "sql.number() expects number or numeric string, got: empty string",
      );
    });

    it("should reject boolean value", () => {
      const number = true;
      expect(() => sql.number(number as any)).toThrow(
        "sql.number() expects number or numeric string, got: boolean",
      );
    });
  });

  describe("string()", () => {
    it("should create a STRING type parameter from a string", () => {
      const string = "Hello, world!";
      const result = sql.string(string);
      expect(result).toEqual({
        __sql_type: "STRING",
        value: "Hello, world!",
      });
    });
    it("should create a STRING type parameter from a number", () => {
      const number = 1234567890;
      const result = sql.string(number);
      expect(result).toEqual({
        __sql_type: "STRING",
        value: "1234567890",
      });
    });
    it("should create a STRING type parameter from a boolean", () => {
      const boolean = true;
      const result = sql.string(boolean);
      expect(result).toEqual({
        __sql_type: "STRING",
        value: "true",
      });
    });
    it("should reject invalid string value", () => {
      const number = null;
      expect(() => sql.string(number as any)).toThrow(
        "sql.string() expects string or number or boolean, got: object",
      );
    });
  });

  describe("boolean()", () => {
    it("should create a BOOLEAN type parameter from a boolean", () => {
      const boolean = true;
      const result = sql.boolean(boolean);
      expect(result).toEqual({
        __sql_type: "BOOLEAN",
        value: "true",
      });
    });

    it("should create a BOOLEAN type parameter from a string", () => {
      const string = "true";
      const result = sql.boolean(string);
      expect(result).toEqual({
        __sql_type: "BOOLEAN",
        value: "true",
      });
    });
    it("should create a BOOLEAN type parameter from a number", () => {
      const number = 1;
      const result = sql.boolean(number);
      expect(result).toEqual({
        __sql_type: "BOOLEAN",
        value: "true",
      });
    });
    it("should reject invalid type  ", () => {
      const rand = null;
      expect(() => sql.boolean(rand as any)).toThrow(
        "sql.boolean() expects boolean or string (true or false) or number (1 or 0), got: object",
      );
    });

    it("should reject invalid number value", () => {
      const number = 7;
      expect(() => sql.boolean(number as any)).toThrow(
        "sql.boolean() expects boolean or string (true or false) or number (1 or 0), got: 7",
      );
    });

    it("should reject invalid string value", () => {
      const string = "hello";
      expect(() => sql.boolean(string as any)).toThrow(
        "sql.boolean() expects boolean or string (true or false) or number (1 or 0), got: hello",
      );
    });
  });

  describe("timestamp()", () => {
    it("should create a TIMESTAMP type parameter from a Date object", () => {
      const date = new Date("2024-01-01T12:00:00Z");
      const result = sql.timestamp(date);
      expect(result).toEqual({
        __sql_type: "TIMESTAMP",
        value: "2024-01-01T12:00:00Z",
      });
    });

    it("should create a TIMESTAMP type parameter from an ISO timestamp string", () => {
      const timestamp = "2024-01-01T12:00:00Z";
      const result = sql.timestamp(timestamp);
      expect(result).toEqual({
        __sql_type: "TIMESTAMP",
        value: "2024-01-01T12:00:00Z",
      });
    });

    it("should create a TIMESTAMP type parameter from a Unix timestamp number", () => {
      const timestamp = 1704110400000;
      const result = sql.timestamp(timestamp);
      expect(result).toEqual({
        __sql_type: "TIMESTAMP",
        value: "2024-01-01T12:00:00Z",
      });
    });

    it("should reject invalid timestamp string", () => {
      const timestamp = "2024-01-01";
      expect(() => sql.timestamp(timestamp as any)).toThrow(
        "sql.timestamp() expects ISO timestamp string (YYYY-MM-DDTHH:MM:SS.mmmZ or YYYY-MM-DDTHH:MM:SS.mmm+HH:MM), got: 2024-01-01",
      );
    });

    it("should reject invalid timestamp number", () => {
      const timestamp = "2024-01-01";
      expect(() => sql.timestamp(timestamp as any)).toThrow(
        "sql.timestamp() expects ISO timestamp string (YYYY-MM-DDTHH:MM:SS.mmmZ or YYYY-MM-DDTHH:MM:SS.mmm+HH:MM), got: 2024-01-01",
      );
    });

    it("should reject invalid timestamp value", () => {
      const timestamp = null;
      expect(() => sql.timestamp(timestamp as any)).toThrow(
        "sql.timestamp() expects Date, ISO timestamp string, or Unix timestamp number, got: object",
      );
    });
  });
});

describe("SQL Type Marker", () => {
  it("should return true if the value is a SQL type marker", () => {
    const value = {
      __sql_type: "TIMESTAMP",
      value: "2024-01-01T12:00:00Z",
    };
    expect(isSQLTypeMarker(value)).toBe(true);
  });
});
