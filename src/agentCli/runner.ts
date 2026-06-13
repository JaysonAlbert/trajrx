import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { getAgentCliProfile, resolveDefaultAgentModel } from "./profiles.js";
import type { AgentCliInvokeRequest, AgentCliInvokeResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveBinary(candidates: string[]): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const name of candidates) {
    if (name.includes("/") && isExecutable(name)) return name;
    for (const dir of pathEnv.split(":")) {
      if (!dir) continue;
      const full = join(dir, name);
      if (isExecutable(full)) return full;
    }
  }
  return null;
}

export function resolveAgentBinary(profileId: string): string {
  const profile = getAgentCliProfile(profileId);
  const binary = resolveBinary(profile.binaryCandidates);
  if (!binary) {
    throw new Error(
      `Agent CLI not found for profile "${profile.id}". Tried: ${profile.binaryCandidates.join(", ")}`
    );
  }
  return binary;
}

export function invokeAgentCli(req: AgentCliInvokeRequest): Promise<AgentCliInvokeResult> {
  const profile = getAgentCliProfile(req.profileId);
  const binary = resolveAgentBinary(req.profileId);
  const model = req.model?.trim() || resolveDefaultAgentModel(profile);
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseArgs = profile.buildArgs({ model });
  const argv = profile.useStdin ? baseArgs : [...baseArgs, req.prompt];
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, {
      cwd: req.cwd,
      env: process.env,
      stdio: profile.useStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    if (profile.useStdin && child.stdin) {
      child.stdin.write(req.prompt, "utf-8");
      child.stdin.end();
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        profileId: profile.id,
        binary,
        argv: [binary, ...argv],
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}

export function formatInvokeCommand(result: AgentCliInvokeResult): string {
  const args = result.argv.slice(1).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a));
  return [result.binary, ...args].join(" ");
}
