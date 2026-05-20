import path from "node:path";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import MagicString from "magic-string";
import type { Plugin } from "vite";

const JSX_ELEMENT_MATCHER = {
  rule: {
    any: [
      { kind: "jsx_opening_element" },
      { kind: "jsx_self_closing_element" },
    ],
  },
};

interface ReactSourceLocPluginOptions {
  /** Absolute app root used for data-source relative paths (typically `process.cwd()`). */
  projectRoot: string;
}

function cleanModuleId(id: string): string {
  return id.split("?")[0].split("#")[0];
}

function shouldTransform(id: string): boolean {
  if (id.includes("\0")) return false;
  if (id.includes("node_modules")) return false;
  return /\.[jt]sx$/.test(cleanModuleId(id));
}

function isNativeJsxTag(name: SgNode): boolean {
  const kind = name.kind();
  if (kind === "member_expression") return false;
  if (kind === "jsx_namespace_name") return false;
  if (kind === "identifier") {
    const tagName = name.text();
    if (!tagName) return false;
    return /^[a-z]/.test(tagName);
  }
  return false;
}

function hasDataSourceAttribute(node: SgNode): boolean {
  for (const attr of node.fieldChildren("attribute")) {
    if (!attr.is("jsx_attribute")) continue;
    for (const child of attr.children()) {
      if (child.is("property_identifier") && child.text() === "data-source") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Injects `data-source="<file>:<line>:<col>"` on native JSX elements so editors
 * can map DOM nodes back to source locations.
 */
export function reactSourceLocPlugin(
  options: ReactSourceLocPluginOptions,
): Plugin {
  const projectRoot = path.resolve(options.projectRoot);

  return {
    name: "react-source-loc",
    enforce: "pre",
    apply: "serve",

    transform(code, id) {
      if (!shouldTransform(id)) return;

      const cleanId = cleanModuleId(id);
      const root = parse(Lang.Tsx, code).root();
      const s = new MagicString(code);
      const relPath = path.relative(projectRoot, cleanId);

      for (const node of root.findAll(JSX_ELEMENT_MATCHER)) {
        const name = node.field("name");
        if (!name || !isNativeJsxTag(name)) continue;
        if (hasDataSourceAttribute(node)) continue;

        const nodeRange = node.range();
        const value = `${relPath}:${nodeRange.start.line + 1}:${nodeRange.start.column}`;
        s.appendLeft(name.range().end.index, ` data-source="${value}"`);
      }

      if (!s.hasChanged()) return;

      return {
        code: s.toString(),
        map: s.generateMap({ hires: true }),
      };
    },
  };
}
