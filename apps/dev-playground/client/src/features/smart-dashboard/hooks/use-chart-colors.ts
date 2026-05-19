import { useEffect, useState } from "react";

interface ChartColors {
  primary: string;
  secondary: string;
  grid: string;
  axis: string;
  tooltipBg: string;
  tooltipFg: string;
}

const LIGHT: ChartColors = {
  primary: "hsl(221, 83%, 53%)",
  secondary: "hsl(142, 71%, 45%)",
  grid: "hsl(220, 13%, 91%)",
  axis: "hsl(215, 16%, 47%)",
  tooltipBg: "hsl(0, 0%, 100%)",
  tooltipFg: "hsl(222, 47%, 11%)",
};

const DARK: ChartColors = {
  primary: "hsl(217, 91%, 70%)",
  secondary: "hsl(152, 69%, 55%)",
  grid: "hsl(215, 14%, 25%)",
  axis: "hsl(217, 20%, 70%)",
  tooltipBg: "hsl(224, 71%, 4%)",
  tooltipFg: "hsl(210, 40%, 96%)",
};

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

export function useChartColors(): ChartColors {
  const [colors, setColors] = useState<ChartColors>(() =>
    isDark() ? DARK : LIGHT,
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setColors(isDark() ? DARK : LIGHT);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return colors;
}
