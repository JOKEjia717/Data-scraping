/** One supervised child process per platform, so polling and recovery never wait on peers. */
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  rpaConsoleError,
  rpaConsoleInfo,
  rpaConsoleWarn
} from "./consolePrivacy.js";
import type { RpaWorkerConfig } from "./rpaWorkerConfig.js";
import type { RpaWorkerRole } from "./rpaTask.js";
import type { PlatformId } from "./types.js";

const DERIVED_ARGUMENTS = new Set([
  "platforms",
  "worker-id",
  "outbox-dir",
  "metrics-dir"
]);

export interface PlatformWorkerLaunchSpec {
  platformId: PlatformId;
  workerId: string;
  outboxDirectory: string;
  metricsDirectory: string;
  argv: string[];
}

export function platformWorkerLaunchSpecs(
  workerRole: RpaWorkerRole,
  config: RpaWorkerConfig,
  originalArgs: readonly string[]
): PlatformWorkerLaunchSpec[] {
  const passthrough = originalArgs.filter((argument) => {
    if (!argument.startsWith("--")) return true;
    return !DERIVED_ARGUMENTS.has(argument.slice(2).split("=", 1)[0]!);
  });
  return config.platforms.map((platformId) => {
    const workerId = `${config.workerId}-${platformId}`;
    const outboxDirectory = path.join(config.outboxDirectory, platformId);
    const metricsDirectory = path.join(config.metricsDirectory, platformId);
    return {
      platformId,
      workerId,
      outboxDirectory,
      metricsDirectory,
      argv: [
        `--worker=${workerRole}`,
        ...passthrough,
        `--platforms=${platformId}`,
        `--worker-id=${workerId}`,
        `--outbox-dir=${outboxDirectory}`,
        `--metrics-dir=${metricsDirectory}`
      ]
    };
  });
}

export interface RpaWorkerFleetOptions {
  childModulePath?: string;
  forkChild?: typeof fork;
  restartDelayMs?: number;
}

interface ChildSlot {
  readonly spec: PlatformWorkerLaunchSpec;
  child?: ChildProcess;
  restartTimer?: NodeJS.Timeout;
  terminal: boolean;
}

export class RpaWorkerFleet {
  private readonly childModulePath: string;
  private readonly forkChild: typeof fork;
  private readonly restartDelayMs: number;
  private readonly slots: ChildSlot[];
  private stopping = false;
  private signalCount = 0;
  private settle?: { resolve: () => void; reject: (error: unknown) => void };
  private oneShotFailure?: Error;

  constructor(
    private readonly workerRole: RpaWorkerRole,
    private readonly config: RpaWorkerConfig,
    specs: readonly PlatformWorkerLaunchSpec[],
    options: RpaWorkerFleetOptions = {}
  ) {
    const extension = path.extname(fileURLToPath(import.meta.url));
    this.childModulePath = options.childModulePath ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), `rpaWorkerCli${extension}`);
    this.forkChild = options.forkChild ?? fork;
    this.restartDelayMs = options.restartDelayMs ?? config.platformProcessRestartMs;
    this.slots = specs.map((spec) => ({ spec, terminal: false }));
  }

  run(): Promise<void> {
    if (this.settle) throw new Error("RPA platform fleet is already running");
    return new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
      for (const slot of this.slots) this.startChild(slot);
      if (this.slots.length === 0) resolve();
    });
  }

  requestStop(signal: NodeJS.Signals | "TEST" = "TEST"): void {
    this.signalCount++;
    if (this.signalCount > 1) {
      rpaConsoleWarn({
        workerId: this.config.workerId,
        event: "FLEET_STOP_ALREADY_REQUESTED",
        batchProgress: `signal=${signal}`
      });
      return;
    }
    this.stopping = true;
    rpaConsoleInfo({
      workerId: this.config.workerId,
      event: "FLEET_DRAIN_REQUESTED",
      batchProgress: `signal=${signal},platforms=${this.slots.length}`
    });
    for (const slot of this.slots) {
      if (slot.restartTimer) clearTimeout(slot.restartTimer);
      slot.restartTimer = undefined;
      if (slot.child?.connected) slot.child.send({ type: "RPA_DRAIN" });
      if (!slot.child) slot.terminal = true;
    }
    this.finishIfTerminal();
  }

  private startChild(slot: ChildSlot): void {
    if (this.stopping) {
      slot.terminal = true;
      this.finishIfTerminal();
      return;
    }
    slot.terminal = false;
    const child = this.forkChild(this.childModulePath, slot.spec.argv, {
      stdio: ["inherit", "inherit", "inherit", "ipc"]
    });
    slot.child = child;
    rpaConsoleInfo({
      workerId: slot.spec.workerId,
      event: "PLATFORM_PROCESS_STARTED",
      platformId: slot.spec.platformId,
      batchProgress: `pid=${child.pid ?? "unknown"}`
    });
    child.once("error", (error) => {
      rpaConsoleError({
        workerId: slot.spec.workerId,
        event: "PLATFORM_PROCESS_ERROR",
        platformId: slot.spec.platformId,
        errorCode: "TECHNICAL_FAILURE",
        error
      });
    });
    child.once("exit", (code, signal) => this.onChildExit(slot, code, signal));
  }

  private onChildExit(
    slot: ChildSlot,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    slot.child = undefined;
    const successful = code === 0;
    rpaConsoleInfo({
      workerId: slot.spec.workerId,
      event: successful ? "PLATFORM_PROCESS_STOPPED" : "PLATFORM_PROCESS_EXITED",
      platformId: slot.spec.platformId,
      batchProgress: `code=${code ?? "null"},signal=${signal ?? "none"}`
    });

    if (this.stopping || successful || this.config.runOnce || this.config.dryRun ||
      this.config.healthCheckOnly) {
      slot.terminal = true;
      if (!successful && !this.stopping) {
        this.oneShotFailure ??= new Error(
          `${slot.spec.platformId} worker exited with code ${code ?? "null"}`
        );
      }
      this.finishIfTerminal();
      return;
    }

    rpaConsoleWarn({
      workerId: slot.spec.workerId,
      event: "PLATFORM_PROCESS_RESTART_SCHEDULED",
      platformId: slot.spec.platformId,
      batchProgress: `delayMs=${this.restartDelayMs}`
    });
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = undefined;
      this.startChild(slot);
    }, this.restartDelayMs);
  }

  private finishIfTerminal(): void {
    if (!this.settle || this.slots.some((slot) => !slot.terminal)) return;
    const settle = this.settle;
    this.settle = undefined;
    if (this.oneShotFailure) settle.reject(this.oneShotFailure);
    else settle.resolve();
  }
}
