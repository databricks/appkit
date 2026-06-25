import { describe, expect, test } from "vitest";
import { ConfigurationError, LakebaseError, ValidationError } from "../errors";

describe("ConfigurationError", () => {
  test("is a LakebaseError with a stable code", () => {
    const err = new ConfigurationError("nope");
    expect(err).toBeInstanceOf(LakebaseError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("CONFIGURATION_ERROR");
    expect(err.name).toBe("ConfigurationError");
  });

  test("missingEnvVar builds a descriptive message and context", () => {
    const err = ConfigurationError.missingEnvVar("PGHOST");
    expect(err.message).toBe("PGHOST environment variable is required");
    expect(err.context).toEqual({ envVar: "PGHOST" });
  });

  test("retains an optional cause", () => {
    const cause = new Error("root");
    const err = new ConfigurationError("wrapped", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("ValidationError", () => {
  test("has its own code and name", () => {
    const err = new ValidationError("bad");
    expect(err).toBeInstanceOf(LakebaseError);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.name).toBe("ValidationError");
  });

  test("invalidValue includes the expected description and field context", () => {
    const err = ValidationError.invalidValue("port", "abc", "a number");
    expect(err.message).toBe("Invalid value for port: expected a number");
    expect(err.context).toEqual({
      field: "port",
      valueType: "string",
      expected: "a number",
    });
  });

  test("invalidValue omits the expectation when not provided", () => {
    const err = ValidationError.invalidValue("field", 42);
    expect(err.message).toBe("Invalid value for field");
    expect(err.context).toMatchObject({ field: "field", valueType: "number" });
  });

  test("reports null values distinctly from objects", () => {
    const err = ValidationError.invalidValue("response", null, "an object");
    expect(err.context).toMatchObject({ valueType: "null" });
  });
});
