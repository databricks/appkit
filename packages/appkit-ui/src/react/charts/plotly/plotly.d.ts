// Ambient declarations for the Plotly runtime packages.
//
// `@types/plotly.js` declares the `"plotly.js"` module (types only). We ship the
// pre-built `plotly.js-dist-min` bundle at runtime (no types) and bind the React
// wrapper via `react-plotly.js/factory` (subpath not covered by the published
// `@types/react-plotly.js`). These declarations map both onto the `plotly.js`
// types so the Plotly chart code is fully typed without pulling in the heavy
// source build.

declare module "plotly.js-dist-min" {
  import * as Plotly from "plotly.js";

  export = Plotly;
}

declare module "react-plotly.js/factory" {
  import type { ComponentType } from "react";
  import type * as Plotly from "plotly.js";
  import type { PlotParams } from "react-plotly.js";

  export default function createPlotlyComponent(
    plotly: typeof Plotly,
  ): ComponentType<PlotParams>;
}
