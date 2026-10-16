import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { app } = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/test/Application Support"),
    setPath: vi.fn(),
  },
}));
vi.mock("electron", () => ({ app }));
import { configureSwarmRuntime, ensureSwarmDaemonConfig } from "./swarm-runtime";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  app.isPackaged = false;
});

describe("standalone Swarm isolation", () => {
  it("overrides inherited official state and disables upstream updates", () => {
    app.isPackaged = true;
    vi.stubEnv("PASEO_HOME", "/official/state");
    vi.stubEnv("PASEO_LISTEN", "127.0.0.1:6767");
    vi.stubEnv("PASEO_ELECTRON_USER_DATA_DIR", "/official/client");
    vi.stubEnv("PASEO_DISABLE_APP_UPDATES", undefined);
    configureSwarmRuntime();
    expect(process.env.PASEO_HOME).toBe(path.join(os.homedir(), ".paseo-swarm"));
    expect(process.env.PASEO_LISTEN).toBe("127.0.0.1:6769");
    expect(app.setPath).toHaveBeenCalledWith(
      "userData",
      path.join("/test/Application Support", "Paseo Swarm"),
    );
    expect(process.env.PASEO_DISABLE_APP_UPDATES).toBe("1");
  });

  it("supports explicit Swarm QA paths and port", () => {
    app.isPackaged = true;
    vi.stubEnv("PASEO_SWARM_HOME", "/qa/state");
    vi.stubEnv("PASEO_SWARM_LISTEN", "127.0.0.1:16769");
    vi.stubEnv("PASEO_SWARM_USER_DATA_DIR", "/qa/client");
    vi.stubEnv("PASEO_HOME", undefined);
    vi.stubEnv("PASEO_LISTEN", undefined);
    vi.stubEnv("PASEO_ELECTRON_USER_DATA_DIR", undefined);
    vi.stubEnv("PASEO_DISABLE_APP_UPDATES", undefined);
    configureSwarmRuntime();
    expect(process.env.PASEO_HOME).toBe("/qa/state");
    expect(process.env.PASEO_LISTEN).toBe("127.0.0.1:16769");
    expect(app.setPath).toHaveBeenCalledWith("userData", "/qa/client");
  });

  it("keeps checkout-specific development state", () => {
    vi.stubEnv("PASEO_HOME", "/checkout/.dev/state");
    configureSwarmRuntime();
    expect(process.env.PASEO_HOME).toBe("/checkout/.dev/state");
    expect(app.setPath).not.toHaveBeenCalled();
  });
});

describe("managed Swarm daemon config", () => {
  it("persists a separate port and keeps unrelated settings", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "swarm-config-"));
    try {
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:6767" }, marker: "kept" }),
      );
      ensureSwarmDaemonConfig(home, "127.0.0.1:6769");
      expect(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"))).toEqual({
        version: 1,
        daemon: { listen: "127.0.0.1:6769" },
        marker: "kept",
      });
      ensureSwarmDaemonConfig(home, "127.0.0.1:6769");
      expect(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).daemon).toEqual({
        listen: "127.0.0.1:6769",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
