import { Listr } from "listr2";
import pc from "picocolors";
import { join } from "node:path";
import { RunLogger } from "./runLogger.js";
import { printRunSummary, writeRunSummaryFiles, type RunSummary } from "./summary.js";

export interface PipelineUiOptions {
  runDir: string;
  verbose?: boolean;
}

export interface StageTask {
  title: string;
  run: (task: StageTaskHandle) => Promise<string>;
}

export interface StageTaskHandle {
  setDetail: (detail: string) => void;
}

interface ListrTaskLike {
  output?: string;
  title?: string;
}

function createTaskHandle(task?: ListrTaskLike): StageTaskHandle {
  return {
    setDetail(detail: string) {
      if (task) task.output = detail;
    },
  };
}

export class PipelineUi {
  readonly logger: RunLogger;
  private readonly verbose: boolean;
  private readonly interactive: boolean;

  constructor(private readonly opts: PipelineUiOptions) {
    this.logger = new RunLogger(opts.runDir);
    this.verbose = opts.verbose ?? false;
    this.interactive = process.stdout.isTTY === true && process.env.CI !== "true" && process.env.TRAJRX_PLAIN !== "1";
  }

  log(message: string): void {
    this.logger.info(message);
    if (this.verbose) {
      console.log(pc.dim(message));
    }
  }

  header(title: string, subtitle?: string): void {
    if (!this.interactive) return;
    console.log("");
    console.log(pc.bold(pc.cyan(`TrajRx · ${title}`)));
    if (subtitle) console.log(pc.dim(subtitle));
    console.log("");
  }

  async runStages(stages: StageTask[]): Promise<void> {
    if (!this.interactive) {
      for (const [index, stage] of stages.entries()) {
        const prefix = `[${index + 1}/${stages.length}]`;
        process.stdout.write(`${prefix} ${stage.title} … `);
        const handle = createTaskHandle();
        handle.setDetail = (detail) => {
          process.stdout.write(`\r${prefix} ${stage.title} · ${detail}`.padEnd(72));
        };
        const result = await stage.run(handle);
        this.log(`${stage.title}: ${result}`);
        process.stdout.write(`\r${prefix} ${stage.title} · ${pc.green("done")} ${pc.dim(result)}\n`);
      }
      return;
    }

    const listr = new Listr(
      stages.map((stage) => ({
        title: stage.title,
        task: async (_ctx, task: ListrTaskLike) => {
          const handle = createTaskHandle(task);
          handle.setDetail("running…");
          const result = await stage.run(handle);
          task.title = `${stage.title} ${pc.dim(result)}`;
          task.output = result;
        },
      })),
      { concurrent: false }
    );

    await listr.run();
  }

  finish(summary: RunSummary): void {
    writeRunSummaryFiles(summary);
    summary.artifacts.unshift(
      { label: "run-summary.md", path: join(summary.run_dir, "run-summary.md"), description: "Run summary for later review" },
      { label: "run.log", path: summary.log_path, description: "Full execution log" },
    );
    printRunSummary(summary, this.verbose);
  }
}
