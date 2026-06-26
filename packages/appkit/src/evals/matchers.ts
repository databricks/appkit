import type { Matcher } from "./types";

/** Passes when the value contains `substring`. */
export function includes(substring: string): Matcher {
  return (value) => ({
    pass: value.includes(substring),
    detail: `expected to include ${JSON.stringify(substring)}`,
  });
}

/** Passes when the value equals `expected` exactly. */
export function equals(expected: string): Matcher {
  return (value) => ({
    pass: value === expected,
    detail: `expected to equal ${JSON.stringify(expected)}`,
  });
}

/** Passes when the value matches `pattern`. */
export function matches(pattern: RegExp): Matcher {
  return (value) => ({
    pass: pattern.test(value),
    detail: `expected to match ${pattern}`,
  });
}
