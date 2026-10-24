import test from "node:test";
import assert from "node:assert/strict";
import { drainWorkerTasks } from "../server/workerRuntime.ts";

test("worker shutdown drains completed work", async () => {
  assert.equal(await drainWorkerTasks([Promise.resolve(), null], 20), true);
  assert.equal(await drainWorkerTasks([], 20), true);
});

test("worker shutdown stops waiting when a task is stuck", async () => {
  let finish!: () => void;
  const stuck = new Promise<void>(resolve => { finish = resolve; });
  const started = Date.now();
  assert.equal(await drainWorkerTasks([stuck], 20), false);
  assert.ok(Date.now() - started < 1_000);
  finish();
});
