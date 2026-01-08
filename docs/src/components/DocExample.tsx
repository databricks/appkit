import React from "react";
import CodeBlock from "@theme/CodeBlock";
import {
  examples,
  type AppKitExampleKey,
} from "../../../packages/appkit-ui/src/react/ui/examples";
import { IframePreview } from "./IframePreview";

interface DocExampleProps {
  name: AppKitExampleKey;
}

export function DocExample({ name }: DocExampleProps) {
  const example = examples[name];
  if (!example) {
    return null;
  }

  const ExampleComponent = example.Component;

  return (
    <section className="doc-example">
      <div className="doc-example-preview">
        <IframePreview>
          <ExampleComponent />
        </IframePreview>
      </div>
      <div className="doc-example-source">
        <CodeBlock language="tsx">{example.source}</CodeBlock>
      </div>
    </section>
  );
}
