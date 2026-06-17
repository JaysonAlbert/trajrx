import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class RunLogger {
  private readonly logPath: string;
  private initialized = false;

  constructor(runDir: string) {
    this.logPath = join(runDir, "run.log");
  }

  get path(): string {
    return this.logPath;
  }

  info(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    if (!this.initialized) {
      writeFileSync(this.logPath, `${line}\n`, "utf-8");
      this.initialized = true;
      return;
    }
    appendFileSync(this.logPath, `${line}\n`, "utf-8");
  }
}
