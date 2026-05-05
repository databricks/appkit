import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import MagicString from 'magic-string';
import path from 'node:path';
import type { Plugin } from 'vite';

// @babel/traverse has different CJS/ESM default export handling
const traverse = (_traverse as unknown as { default: typeof _traverse }).default ?? _traverse;

export default function reactSourceLoc(): Plugin {
  let projectRoot: string;

  return {
    name: 'react-source-loc',
    enforce: 'pre',

    configResolved(config) {
      // Vite root is client/; project root is one level up
      projectRoot = path.resolve(config.root, '..');
    },

    transform(code, id) {
      if (!/\.[jt]sx$/.test(id)) return;
      if (id.includes('node_modules')) return;

      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'],
      });

      const s = new MagicString(code);
      const relPath = path.relative(projectRoot, id);

      traverse(ast, {
        JSXOpeningElement(nodePath) {
          const name = nodePath.node.name;

          // Skip fragments
          if (name.type === 'JSXIdentifier' && name.name === '') return;

          // Skip React components (uppercase or member expressions)
          if (name.type === 'JSXMemberExpression') return;
          if (name.type === 'JSXIdentifier' && /^[A-Z]/.test(name.name)) return;

          const loc = nodePath.node.loc;
          if (!loc) return;

          // Skip if data-source already exists
          const alreadyHas = nodePath.node.attributes.some(
            (attr) => attr.type === 'JSXAttribute' && attr.name.type === 'JSXIdentifier' && attr.name.name === 'data-source'
          );
          if (alreadyHas) return;

          const value = `${relPath}:${loc.start.line}:${loc.start.column}`;
          const attr = ` data-source="${value}"`;

          // Find the tag name end position to insert the attribute
          const nameNode = nodePath.node.name;
          const insertPos = nameNode.end!;
          s.appendLeft(insertPos, attr);
        },
      });

      return {
        code: s.toString(),
        map: s.generateMap({ hires: true }),
      };
    },
  };
}
