export function deepMerge<T extends Record<string, any>>(
  target: T,
  ...sources: Array<Partial<T> | undefined>
): T {
  if (!sources.length) return target;

  const source = sources.shift();
  if (!source) return deepMerge(target, ...sources);

  const result = { ...target };

  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (sourceValue !== undefined) {
      if (isObject(sourceValue) && isObject(targetValue)) {
        result[key] = deepMerge(
          targetValue as Record<string, any>,
          sourceValue as Record<string, any>,
        ) as T[Extract<keyof T, string>];
      } else {
        result[key] = sourceValue as T[Extract<keyof T, string>];
      }
    }
  }

  return sources.length ? deepMerge(result, ...sources) : result;
}

function isObject(item: unknown): item is Record<string, any> {
  return typeof item === "object" && item !== null && !Array.isArray(item);
}
