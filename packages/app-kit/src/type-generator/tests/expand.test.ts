import ts from "typescript";
import { describe, expect, test } from "vitest";
import { expandType } from "../expand";

function createProgramWithSource(
  source: string,
  options: ts.CompilerOptions = {},
) {
  const fileName = "test.ts";
  const compilerHost = ts.createCompilerHost({});
  const originalGetSourceFile = compilerHost.getSourceFile;

  compilerHost.getSourceFile = (name, languageVersion, onError) => {
    if (name === fileName) {
      return ts.createSourceFile(name, source, languageVersion, true);
    }
    return originalGetSourceFile(name, languageVersion, onError);
  };

  compilerHost.fileExists = (name) =>
    name === fileName || ts.sys.fileExists(name);
  compilerHost.readFile = (name) =>
    name === fileName ? source : ts.sys.readFile(name);

  const program = ts.createProgram(
    [fileName],
    { noEmit: true, ...options },
    compilerHost,
  );
  return { program, fileName };
}

function getTypeFromSource(
  source: string,
  typeName: string,
  options: ts.CompilerOptions = {},
) {
  const { program, fileName } = createProgramWithSource(source, options);
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    throw new Error(`Could not get source file: ${fileName}`);
  }
  const typeChecker = program.getTypeChecker();

  let foundType: ts.Type | null = null;

  function visit(node: ts.Node) {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      foundType = typeChecker.getTypeAtLocation(node.name);
    }
    if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
      foundType = typeChecker.getTypeAtLocation(node.name);
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  if (!foundType) {
    throw new Error(`Type ${typeName} not found in source`);
  }
  return { type: foundType, typeChecker };
}

describe("expandType", () => {
  describe("primitive types", () => {
    test("expands string type", () => {
      const { type, typeChecker } = getTypeFromSource(
        "type TestType = string;",
        "TestType",
      );
      expect(expandType(type, typeChecker)).toBe("string");
    });

    test("expands number type", () => {
      const { type, typeChecker } = getTypeFromSource(
        "type TestType = number;",
        "TestType",
      );
      expect(expandType(type, typeChecker)).toBe("number");
    });

    test("expands boolean type", () => {
      const { type, typeChecker } = getTypeFromSource(
        "type TestType = boolean;",
        "TestType",
      );
      const result = expandType(type, typeChecker);
      // TypeScript internally represents boolean as "false | true" union
      expect(result === "boolean" || result === "false | true").toBe(true);
    });
  });

  describe("union types", () => {
    test("expands string literal union", () => {
      const { type, typeChecker } = getTypeFromSource(
        'type TestType = "a" | "b" | "c";',
        "TestType",
      );
      const result = expandType(type, typeChecker);
      expect(result).toContain('"a"');
      expect(result).toContain('"b"');
      expect(result).toContain('"c"');
      expect(result).toContain("|");
    });

    test("expands mixed union", () => {
      const { type, typeChecker } = getTypeFromSource(
        "type TestType = string | number | null;",
        "TestType",
        { strictNullChecks: true }, // Required for null to be preserved in union
      );
      const result = expandType(type, typeChecker);
      expect(result).toContain("string");
      expect(result).toContain("number");
      expect(result).toContain("null");
    });
  });

  describe("object types", () => {
    test("expands simple object", () => {
      const { type, typeChecker } = getTypeFromSource(
        "interface TestType { id: string; count: number; }",
        "TestType",
      );
      const result = expandType(type, typeChecker);
      expect(result).toContain("id");
      expect(result).toContain("string");
      expect(result).toContain("count");
      expect(result).toContain("number");
    });

    test("expands nested object", () => {
      const { type, typeChecker } = getTypeFromSource(
        "interface TestType { user: { name: string; age: number; }; }",
        "TestType",
      );
      const result = expandType(type, typeChecker);
      expect(result).toContain("user");
      expect(result).toContain("name");
      expect(result).toContain("string");
      expect(result).toContain("age");
      expect(result).toContain("number");
    });

    test("expands optional properties", () => {
      const { type, typeChecker } = getTypeFromSource(
        "interface TestType { required: string; optional?: number; }",
        "TestType",
      );
      const result = expandType(type, typeChecker);
      expect(result).toContain("required");
      expect(result).toContain("optional?");
    });
  });

  describe("array types", () => {
    test("expands primitive array", () => {
      const { type, typeChecker } = getTypeFromSource(
        "type TestType = string[];",
        "TestType",
      );
      const result = expandType(type, typeChecker);
      expect(result).toContain("string");
      expect(result).toContain("[]");
    });

    test("expands object array", () => {
      const { type, typeChecker } = getTypeFromSource(
        "type TestType = { id: string; name: string; }[];",
        "TestType",
      );
      const result = expandType(type, typeChecker);
      expect(result).toContain("id");
      expect(result).toContain("name");
      expect(result).toContain("[]");
    });
  });

  describe("intersection types", () => {
    test("expands intersection", () => {
      const { type, typeChecker } = getTypeFromSource(
        `
        interface A { a: string; }
        interface B { b: number; }
        type TestType = A & B;
        `,
        "TestType",
      );
      const result = expandType(type, typeChecker);
      expect(result).toContain("a");
      expect(result).toContain("string");
      expect(result).toContain("b");
      expect(result).toContain("number");
    });
  });

  describe("built-in types", () => {
    test("preserves Date type", () => {
      const { type, typeChecker } = getTypeFromSource(
        "type TestType = Date;",
        "TestType",
      );
      const result = expandType(type, typeChecker);
      expect(result).toBe("Date");
    });

    test("preserves Promise type", () => {
      const { type, typeChecker } = getTypeFromSource(
        "type TestType = Promise<string>;",
        "TestType",
      );
      const result = expandType(type, typeChecker);
      expect(result).toContain("Promise");
    });
  });
});
