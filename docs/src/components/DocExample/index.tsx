import CodeBlock from "@theme/CodeBlock";
import { examples, type AppKitExampleKey } from "./examples.gen";
import { IframePreview } from "./IframePreview";

interface DocExampleProps {
  name: AppKitExampleKey;
}

/**
 * Manual height overrides for components that need specific heights.
 * These are necessary for components that:
 * - Open modals/overlays that extend beyond default viewport
 * - Have animations that require vertical space
 * - Display dropdowns or popovers that need room to expand
 */
const HEIGHT_OVERRIDES = {
  dialog: 600,
  drawer: 700,
  "hover-card": 400,
  "navigation-menu": 600,
  menubar: 500,
  popover: 450,
  sheet: 700,
  "dropdown-menu": 500,
  select: 450,
  "alert-dialog": 500,
  "context-menu": 500,
} as const satisfies Partial<Record<AppKitExampleKey, number>>;

export function DocExample({ name }: DocExampleProps) {
  const example = examples[name];
  if (!example) {
    return null;
  }

  const ExampleComponent = example.Component;
  const customHeight = HEIGHT_OVERRIDES[name];

  return (
    <section className="doc-example">
      <div className="doc-example-preview">
        <IframePreview customHeight={customHeight} componentName={name}>
          <ExampleComponent />
        </IframePreview>
      </div>
      <div className="doc-example-source">
        <CodeBlock language="tsx">{example.source}</CodeBlock>
      </div>
    </section>
  );
}
