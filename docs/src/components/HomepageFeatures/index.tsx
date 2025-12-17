import type { ReactNode } from "react";
import clsx from "clsx";
import Heading from "@theme/Heading";
import styles from "./styles.module.css";
import LayersIcon from "./icons/layers.svg";
import CodeIcon from "./icons/code.svg";
import SparklesIcon from "./icons/sparkles.svg";
import PuzzleIcon from "./icons/puzzle.svg";

type FeatureItem = {
  title: string;
  Icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: "Full-Stack SDK",
    Icon: LayersIcon,
    description: (
      <>
        Backend with Express, Vite, and plugins. Frontend with React hooks,
        charts, and UI components. Everything you need out-of-the-box.
      </>
    ),
  },
  {
    title: "Extensible Plugins",
    Icon: PuzzleIcon,
    description: (
      <>
        Plugin system with lifecycle phases, built-in plugins for common tasks,
        and full support for custom plugins. Extend at any level.
      </>
    ),
  },
  {
    title: "Type-Safe SQL Queries",
    Icon: CodeIcon,
    description: (
      <>
        Write Databricks SQL queries and get TypeScript types automatically.
        Full parameter type safety across your entire stack.
      </>
    ),
  },
  {
    title: "Built for Humans & AI",
    Icon: SparklesIcon,
    description: (
      <>
        Designed for both developers and AI agents. Every API is discoverable,
        self-documenting, and inferable by humans and LLMs alike.
      </>
    ),
  },
];

function Feature({ title, Icon, description }: FeatureItem) {
  return (
    <div className={clsx("col col--6")}>
      <div className={styles.featureCard}>
        <div className={styles.featureIcon}>
          <Icon />
        </div>
        <Heading as="h3" className={styles.featureTitle}>
          {title}
        </Heading>
        <p className={styles.featureDescription}>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className={clsx("row", styles.featuresContainer)}>
          {FeatureList.map((props) => (
            <Feature key={props.title} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
