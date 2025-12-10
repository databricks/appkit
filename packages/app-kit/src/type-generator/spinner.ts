/**
 * Simple loading spinner for CLI
 */
export class Spinner {
  private frames = ["   ", ".  ", ".. ", "..."];
  private current = 0;
  private interval: NodeJS.Timeout | null = null;
  private text = "";

  start(text: string) {
    this.text = text;
    this.current = 0;
    process.stdout.write(`  ${this.text}${this.frames[0]}`);
    this.interval = setInterval(() => {
      this.current = (this.current + 1) % this.frames.length;
      process.stdout.write(`\r  ${this.text}${this.frames[this.current]}`);
    }, 300);
  }

  stop(finalText?: string) {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // clear the line and write the final text
    process.stdout.write(`\x1b[2K\r  ${finalText || this.text}\n`);
  }
}
