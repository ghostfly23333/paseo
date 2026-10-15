import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { assertNoRunningAgents, installWithRollback } from "./release-swarm-local.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-release-"));
  const destination = path.join(root, "installed.app");
  const staged = path.join(root, "staged.app");
  const previous = path.join(root, "backup", "previous.app");
  for (const [dir, value] of [
    [destination, "old"],
    [staged, "new"],
  ]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "version"), value);
  }
  return { root, destination, staged, previous };
}

test("keeps previous App after successful startup verification", async () => {
  const f = fixture();
  try {
    const result = await installWithRollback({
      ...f,
      afterInstall: async () => {
        assert.equal(fs.readFileSync(path.join(f.destination, "version"), "utf8"), "new");
        return "healthy";
      },
    });
    assert.equal(result, "healthy");
    assert.equal(fs.readFileSync(path.join(f.previous, "version"), "utf8"), "old");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("restores previous App and restarts it when new startup fails", async () => {
  const f = fixture();
  const calls = [];
  try {
    await assert.rejects(
      installWithRollback({
        ...f,
        afterInstall: async () => {
          throw new Error("plugin did not load");
        },
        beforeRollback: async () => {
          calls.push("stop failed App");
        },
        afterRollback: async () => {
          calls.push("restart old App");
        },
      }),
      /plugin did not load/,
    );
    assert.equal(fs.readFileSync(path.join(f.destination, "version"), "utf8"), "old");
    assert.equal(fs.readFileSync(path.join(f.staged, "version"), "utf8"), "new");
    assert.deepEqual(calls, ["stop failed App", "restart old App"]);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("restores bundle even if stopping failed App reports an error", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      installWithRollback({
        ...f,
        afterInstall: async () => {
          throw new Error("bad startup");
        },
        beforeRollback: async () => {
          throw new Error("stop failed");
        },
      }),
      /previous bundle restored/,
    );
    assert.equal(fs.readFileSync(path.join(f.destination, "version"), "utf8"), "old");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("blocks updates while an Agent is running", () => {
  assert.throws(
    () => assertNoRunningAgents([{ id: "worker", status: "running" }]),
    /running agents: worker/,
  );
  assertNoRunningAgents([{ id: "worker", status: "idle" }]);
});
