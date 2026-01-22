#!/usr/bin/env node
/**
 * Validates JSON files against the AppKit plugin schema.
 * Usage: npx appkit-schema-validate <json-file> [--schema <schema-file>]
 */
import Ajv from "ajv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default schema location (relative to package root)
const DEFAULT_SCHEMA_PATH = path.resolve(
  __dirname,
  "../../../plugin-schema.json",
);

function printUsage() {
  console.log(`
Usage: appkit-schema-validate <json-file> [options]

Options:
  --schema <path>   Path to custom JSON schema file (default: plugin-schema.json)
  --help, -h        Show this help message

Examples:
  appkit-schema-validate my-plugin.json
  appkit-schema-validate manifest.json --schema custom-schema.json
`);
}

function parseArgs(args) {
  const result = {
    jsonFile: null,
    schemaFile: DEFAULT_SCHEMA_PATH,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--schema") {
      result.schemaFile = args[++i];
    } else if (!arg.startsWith("-")) {
      result.jsonFile = arg;
    }
  }

  return result;
}

function loadJson(filePath, description) {
  if (!fs.existsSync(filePath)) {
    console.error(`Error: ${description} not found: ${filePath}`);
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error: Failed to parse ${description}: ${err.message}`);
    process.exit(1);
  }
}

function formatError(error, data) {
  const path = error.instancePath || "(root)";
  let message = `  ${path}: ${error.message}`;

  if (error.keyword === "additionalProperties") {
    message += ` ('${error.params.additionalProperty}')`;
  }

  if (error.keyword === "enum") {
    message += ` (allowed: ${error.params.allowedValues.join(", ")})`;
  }

  if (error.keyword === "pattern") {
    message += ` (pattern: ${error.params.pattern})`;
  }

  return message;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (!args.jsonFile) {
    console.error("Error: No JSON file specified.\n");
    printUsage();
    process.exit(1);
  }

  // Resolve file paths
  const jsonPath = path.resolve(process.cwd(), args.jsonFile);
  const schemaPath = path.isAbsolute(args.schemaFile)
    ? args.schemaFile
    : path.resolve(process.cwd(), args.schemaFile);

  // Load files
  const schema = loadJson(schemaPath, "Schema file");
  const data = loadJson(jsonPath, "JSON file");

  // Validate
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(data);

  const relPath = path.relative(process.cwd(), jsonPath);

  if (valid) {
    console.log(`✓ ${relPath} is valid against the schema.`);
    process.exit(0);
  }

  // Report errors
  console.error(`✗ ${relPath} has validation errors:\n`);

  for (const error of validate.errors) {
    console.error(formatError(error, data));
  }

  console.error(`\nFound ${validate.errors.length} error(s).`);
  process.exit(1);
}

main();
