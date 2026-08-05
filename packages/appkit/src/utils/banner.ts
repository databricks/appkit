/**
 * Frames content lines in an ASCII box (`===` border, `| … |` sides) padded to
 * the widest line. Used for prominent dev-mode warnings that must not be missed
 * in a noisy console.
 */
export function formatWarningBanner(lines: string[]): string {
  const maxLen = Math.max(...lines.map((l) => l.length));
  const border = "=".repeat(maxLen + 4);
  const boxed = lines.map((line) => `| ${line.padEnd(maxLen)} |`);
  return [border, ...boxed, border].join("\n");
}
