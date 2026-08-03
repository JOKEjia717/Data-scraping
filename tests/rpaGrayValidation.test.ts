import assert from "node:assert/strict";
import test from "node:test";
import { validateGrayConfiguration } from "../src/rpaGrayValidation.js";

test("灰度静态门禁要求 staging、dry-run、单平台、白名单和 provider 隔离", () => {
  const safe = validateGrayConfiguration("diagnosis", [
    "--environment=staging",
    "--dry-run=true",
    "--max-tasks=1",
    "--platforms=doubao",
    "--gray-brand-ids=10001",
    "--provider-routing-enabled=true",
    "--provider=NEW_RPA"
  ], {}, "/workspace");
  assert.equal(safe.safe, true);

  const unsafe = validateGrayConfiguration("monitor", [], {}, "/workspace");
  assert.equal(unsafe.safe, false);
  assert.ok(unsafe.checks.some((item) => item.includes("白名单")));
  assert.ok(unsafe.checks.some((item) => item.includes("provider")));
});
