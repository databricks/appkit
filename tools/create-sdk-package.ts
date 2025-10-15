import path from "path";
import type { NodePlopAPI } from "plop";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const getTemplateDir = (type: string) => path.join(__dirname, "templates", type);

export default function (plop: NodePlopAPI) {
  plop.setGenerator("package", {
    description: "Generate a new SDK package",
    prompts: [
      {
        type: "input",
        name: "name",
        message: "Package name (e.g., auth)",
        validate: (value) => {
          if (!value) {
            return "Package name is required";
          }
          return true;
        },
      },
      {
        type: "list",
        name: "type",
        message: "Package type",
        choices: ["backend", "frontend"],
        validate: (value) => {
          if (!value) {
            return "Package type is required";
          }
          return true;
        },
      },
    ],
    actions(data) {
      if (!data?.type || !data?.name) {
        throw new Error("type or name is missing");
      }

      const type = data.type;
      const basePath = path.join(process.cwd(), "packages", type, data.name);
      const templateDir = getTemplateDir(type);
      return [
        {
          type: "add",
          path: `${basePath}/package.json`,
          templateFile: path.join(templateDir, "package.json.hbs"),
        },
        {
          type: "add",
          path: `${basePath}/tsconfig.json`,
          templateFile: path.join(templateDir, "tsconfig.json.hbs"),
        },
        {
          type: "add",
          path: `${basePath}/src/index.ts`,
          templateFile: path.join(templateDir, "index.ts.hbs"),
        },
        {
          type: "add",
          path: `${basePath}/src/index.test.ts`,
          templateFile: path.join(templateDir, "index.test.ts.hbs"),
        },
      ];
    },
  });
}
