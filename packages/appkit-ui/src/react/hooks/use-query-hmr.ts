import { useEffect } from "react";

export function useQueryHMR(
  key: string,
  onUpdate: (timestamp: number) => void,
) {
  useEffect(() => {
    // 1. only run in dev mode with HMR
    if (!import.meta.env.DEV || !import.meta.hot) return;

    // 2. listen for hmr updates
    const handler = (data: { key: string; timestamp: number }) => {
      if (data.key === key) {
        onUpdate(Date.now());
      }
    };

    // 3. register listener
    import.meta.hot.on("query-update", handler);

    return () => {
      // 4. cleanup listener on unmount
      import.meta.hot?.off?.("query-update", handler);
    };
  }, [key, onUpdate]);
}
