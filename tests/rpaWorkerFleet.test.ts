import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import type { ChildProcess, fork } from "node:child_process";
import { parseRpaWorkerConfig } from "../src/rpaWorkerConfig.js";
import {
  platformWorkerLaunchSpecs,
  RpaWorkerFleet
} from "../src/rpaWorkerFleet.js";

class FakeChild extends EventEmitter {
  readonly pid: number;
  connected = true;
  readonly messages: unknown[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  send(message: unknown): boolean {
    this.messages.push(message);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.connected = false;
    this.emit("exit", code, signal);
  }
}

test("四个平台生成互相隔离的 workerId、Outbox、指标目录和单平台参数", () => {
  const config = parseRpaWorkerConfig("diagnosis", [
    "--dry-run=false",
    "--platforms=doubao,deepseek,qianwen,yuanbao"
  ], {}, "/workspace");
  const specs = platformWorkerLaunchSpecs("diagnosis", config, [
    "--dry-run=false",
    "--platforms=doubao,deepseek,qianwen,yuanbao"
  ]);

  assert.deepEqual(specs.map(({ platformId }) => platformId), [
    "doubao", "deepseek", "qianwen", "yuanbao"
  ]);
  for (const spec of specs) {
    assert.equal(spec.workerId, `diagnosis-worker-${spec.platformId}`);
    assert.equal(spec.outboxDirectory, path.join(config.outboxDirectory, spec.platformId));
    assert.equal(spec.metricsDirectory, path.join(config.metricsDirectory, spec.platformId));
    assert.ok(spec.argv.includes(`--platforms=${spec.platformId}`));
    assert.ok(spec.argv.includes(`--worker-id=${spec.workerId}`));
    assert.equal(
      spec.argv.some((argument) => argument === "--platforms=doubao,deepseek,qianwen,yuanbao"),
      false
    );
  }
});

test("单个平台异常只重启该平台，排空信号通过 IPC 安全通知所有存活平台", async () => {
  const config = parseRpaWorkerConfig("diagnosis", [
    "--dry-run=false",
    "--platforms=doubao,qianwen"
  ], {}, "/workspace");
  const specs = platformWorkerLaunchSpecs("diagnosis", config, [
    "--dry-run=false",
    "--platforms=doubao,qianwen"
  ]);
  const children: FakeChild[] = [];
  const fakeFork = (() => {
    const child = new FakeChild(100 + children.length);
    children.push(child);
    return child as unknown as ChildProcess;
  }) as typeof fork;
  const fleet = new RpaWorkerFleet("diagnosis", config, specs, {
    childModulePath: "fake-worker.js",
    forkChild: fakeFork,
    restartDelayMs: 5
  });

  const running = fleet.run();
  assert.equal(children.length, 2);
  const originalQianwen = children[1]!;
  children[0]!.exit(1);
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.equal(children.length, 3);
  assert.equal(originalQianwen.connected, true);

  fleet.requestStop("TEST");
  assert.deepEqual(originalQianwen.messages, [{ type: "RPA_DRAIN" }]);
  assert.deepEqual(children[2]!.messages, [{ type: "RPA_DRAIN" }]);
  originalQianwen.exit(0);
  children[2]!.exit(0);
  await running;
});
