#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const appName = "Paseo Swarm.app";
const bundleId = "local.sevenmile.paseo.swarm";
const installed = path.join("/Applications", appName);
const home = path.join(os.homedir(), ".paseo-swarm");
const registrationTool =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const releaseRoot = path.join(os.homedir(), ".paseo-swarm-releases");
const backup = path.join(releaseRoot, "previous", appName);
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("PASEO_") && key !== "ELECTRON_RUN_AS_NODE",
    ),
  );

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: cleanEnv(),
    encoding: "utf8",
    timeout: 60_000,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`,
    );
  }
  return result.stdout.trim();
}

function assertSwarmBundle(bundle) {
  const identity = capture("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    path.join(bundle, "Contents", "Info.plist"),
  ]);
  if (identity !== bundleId)
    throw new Error(`Refusing to replace or launch a different application: ${bundle}`);
}

function shim(bundle = installed) {
  return path.join(bundle, "Contents", "Resources", "bin", "paseo");
}

function cli(args, bundle = installed) {
  return JSON.parse(capture(shim(bundle), [...args, "--home", home, "--json"]));
}

export function assertNoRunningAgents(agents) {
  const active = agents.filter((agent) => agent.status === "running");
  if (active.length)
    throw new Error(
      `Swarm still has running agents: ${active.map((agent) => agent.name ?? agent.id).join(", ")}. Wait for them to finish before releasing.`,
    );
}

function checkRunningAgents() {
  if (!fs.existsSync(installed)) return;
  assertSwarmBundle(installed);
  const status = cli(["daemon", "status"]);
  if (status.localDaemon === "not_ready")
    throw new Error("Swarm daemon is still starting; retry once it is ready.");
  if (status.localDaemon === "running") assertNoRunningAgents(cli(["ls", "-a", "-g"]));
}

async function stopInstalled() {
  if (!fs.existsSync(installed)) return;
  assertSwarmBundle(installed);
  const executable = path.join(installed, "Contents", "MacOS", "Paseo Swarm");
  const processes = capture("ps", ["-axo", "pid=,comm="]).split("\n");
  const pids = processes.flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match?.[2] === executable ? [Number(match[1])] : [];
  });
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const alive = pids.some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!alive) break;
    if (attempt === 49)
      throw new Error("Swarm GUI did not stop; installed application was left in place.");
    await delay(200);
  }
  cli(["daemon", "stop"]);
}

function registerApp() {
  capture(registrationTool, ["-f", installed]);
  capture("mdimport", ["-i", installed]);
}

async function launchAndVerify(logFile) {
  const logFd = fs.openSync(logFile, "a");
  try {
    const app = spawn(path.join(installed, "Contents", "MacOS", "Paseo Swarm"), [], {
      env: cleanEnv(),
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    app.unref();
  } finally {
    fs.closeSync(logFd);
  }
  let status;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    status = cli(["daemon", "status"]);
    if (status.localDaemon === "running") break;
    await delay(1000);
  }
  if (status?.localDaemon !== "running" || !status.listen || status.home !== home)
    throw new Error(`Installed Swarm daemon did not become ready. See ${logFile}`);
  if (status.listen === "127.0.0.1:6767")
    throw new Error("Swarm selected the official daemon port; refusing verification.");
  const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
  const { WebSocket } = await import("ws");
  const { readLocalCredentialForTarget } = await import("@getpaseo/server/daemon-control");
  const client = new DaemonClient({
    url: `ws://${status.listen}/ws`,
    clientId: "swarm-local-release",
    localCredential: () => readLocalCredentialForTarget(home, status.listen) ?? undefined,
    webSocketFactory: (url, options) =>
      new WebSocket(url, options?.protocols, { headers: options?.headers }),
  });
  try {
    await client.connect();
    const plugins = await client.getPluginCatalog();
    if (!plugins.some((plugin) => plugin.id === "paseo-swarm"))
      throw new Error("Installed Swarm plugin did not load.");
    await client.invokePluginRpc("paseo-swarm", "swarm.board.read", {});
  } finally {
    await client.close();
  }
  return { home: status.home, listen: status.listen, serverId: status.serverId, swarmLoaded: true };
}

// Keep the previous bundle until the replacement has passed its real startup check.
export async function installWithRollback({
  staged,
  destination,
  previous,
  afterInstall,
  beforeRollback = async () => {},
  afterRollback = async () => {},
}) {
  const hadPrevious = fs.existsSync(destination);
  if (hadPrevious) {
    fs.mkdirSync(path.dirname(previous), { recursive: true });
    fs.rmSync(previous, { recursive: true, force: true });
    fs.renameSync(destination, previous);
  }
  try {
    fs.renameSync(staged, destination);
    return await afterInstall();
  } catch (error) {
    let stopError;
    try {
      await beforeRollback();
    } catch (failure) {
      stopError = failure;
    }
    if (fs.existsSync(destination)) fs.renameSync(destination, staged);
    if (hadPrevious) {
      fs.renameSync(previous, destination);
      await afterRollback();
    }
    if (stopError)
      throw new Error(
        `Release failed; previous bundle restored. Stopping the failed App also reported: ${stopError.message}`,
        { cause: error },
      );
    throw error;
  }
}

async function build(logFile) {
  const logFd = fs.openSync(logFile, "a");
  try {
    for (const args of [
      ["ci", "--no-audit", "--no-fund"],
      ["run", "build:desktop", "--", "--mac", "dmg", `--${process.arch}`, "--publish", "never"],
    ]) {
      console.log(`→ npm ${args.join(" ")} (log: ${logFile})`);
      const child = spawn("npm", args, {
        cwd: root,
        env: { ...cleanEnv(), LEFTHOOK: "0", CSC_IDENTITY_AUTO_DISCOVERY: "false" },
        stdio: ["ignore", logFd, logFd],
      });
      const [code, signal] = await once(child, "exit");
      if (code !== 0) throw new Error(`npm failed (${signal ?? code}); see ${logFile}`);
    }
  } finally {
    fs.closeSync(logFd);
  }
}

export async function releaseLocal(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log(
      "npm run release:local [-- --install-only]\nBuild, install, register and verify the current checkout. --install-only reuses its packaged App. Source is never pulled automatically.",
    );
    return;
  }
  if (args.some((arg) => arg !== "--install-only")) throw new Error("Unknown option; use --help.");
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
    throw new Error("This release command requires a supported macOS host.");
  fs.accessSync("/Applications", fs.constants.W_OK);
  fs.mkdirSync(releaseRoot, { recursive: true });
  const lock = path.join(releaseRoot, "release.lock");
  if (fs.existsSync(lock)) {
    const owner = Number(fs.readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(owner) || owner <= 0)
      throw new Error(`Invalid release lock: ${lock}`);
    try {
      process.kill(owner, 0);
      throw new Error(`Release already running (PID ${owner}).`);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    fs.unlinkSync(lock);
  }
  const lockFd = fs.openSync(lock, "wx");
  fs.writeFileSync(lockFd, String(process.pid));
  fs.closeSync(lockFd);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(releaseRoot, "runs", runId);
  const staged = path.join("/Applications", `.Paseo-Swarm-stage-${process.pid}.app`);
  fs.mkdirSync(runDir, { recursive: true });
  try {
    checkRunningAgents();
    // npm prepare must never install this checkout's hooks into a global hooks directory.
    capture("git", ["config", "--local", "core.hooksPath", ".git/hooks"]);
    if (!args.includes("--install-only")) await build(path.join(runDir, "build.log"));
    const artifact = path.join(
      root,
      "packages",
      "desktop",
      "release",
      process.arch === "arm64" ? "mac-arm64" : "mac",
      appName,
    );
    assertSwarmBundle(artifact);
    capture("codesign", ["--verify", "--deep", "--strict", artifact]);
    capture("ditto", [artifact, staged]);
    assertSwarmBundle(staged);
    capture("codesign", ["--verify", "--deep", "--strict", staged]);
    if (fs.existsSync(backup)) assertSwarmBundle(backup);
    checkRunningAgents();
    console.log("→ Installing verified App; preserving Swarm data and previous bundle");
    await stopInstalled();
    const health = await installWithRollback({
      staged,
      destination: installed,
      previous: backup,
      afterInstall: async () => {
        registerApp();
        return launchAndVerify(path.join(runDir, "app.log"));
      },
      beforeRollback: stopInstalled,
      afterRollback: async () => {
        registerApp();
        await launchAndVerify(path.join(runDir, "rollback.log"));
      },
    });
    const indexed = capture("mdfind", [`kMDItemCFBundleIdentifier == "${bundleId}"`])
      .split("\n")
      .includes(installed);
    const manifest = {
      releasedAt: new Date().toISOString(),
      app: installed,
      backup,
      builtFromCurrentCheckout: !args.includes("--install-only"),
      checkoutCommit: capture("git", ["rev-parse", "HEAD"]),
      checkoutDirty: Boolean(capture("git", ["status", "--porcelain"])),
      lockfileSha256: createHash("sha256")
        .update(fs.readFileSync(path.join(root, "package-lock.json")))
        .digest("hex"),
      spotlightIndexed: indexed,
      ...health,
    };
    fs.writeFileSync(path.join(runDir, "release.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(
      `✓ Installed and verified: ${installed}\n✓ Swarm: ${health.listen}\n✓ Release record: ${runDir}\n${indexed ? "✓ Spotlight indexed" : "Spotlight registration and indexing requested; macOS has not indexed it yet."}`,
    );
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
    fs.unlinkSync(lock);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  releaseLocal().catch((error) => {
    console.error(`Release failed: ${error.message}`);
    process.exitCode = 1;
  });
}
