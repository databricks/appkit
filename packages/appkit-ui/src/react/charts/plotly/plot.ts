import Plotly from "plotly.js-dist-min";
import createPlotlyComponent from "react-plotly.js/factory";

// Bind react-plotly.js to the pre-built minified bundle once and share the
// resulting component across all Plotly charts. The bundle is a peer dependency
// (kept external by the SDK build) so consumers control the exact Plotly
// version they ship.
export const Plot = createPlotlyComponent(Plotly);
