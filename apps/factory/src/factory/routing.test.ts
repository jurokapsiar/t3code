import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import config from "../../vite.config";

afterEach(() => vi.unstubAllEnvs());

function readConfig(command: "serve" | "build" = "serve") {
  if (typeof config !== "function") throw new Error("Expected a Vite config factory");
  return config({ command, mode: "development" });
}

describe("same-origin development routing", () => {
  it("proxies all factory transports but leaves pairing HTML on the canonical server", () => {
    vi.stubEnv("FACTORY_UPSTREAM", "http://localhost:4773");
    const settings = readConfig();
    for (const route of [
      "/ws",
      "/api",
      "/factory/bootstrap",
      "/factory/env",
      "/oauth",
      "/.well-known",
    ]) {
      expect(settings.server?.proxy?.[route]).toMatchObject({ target: "http://localhost:4773" });
    }
    expect(settings.server?.proxy?.["/ws"]).toMatchObject({ ws: true });
    expect(settings.server?.proxy?.["/factory/env"]).toMatchObject({ ws: true });
    expect(settings.base).toBe("/");
    expect(readConfig("build").base).toBe("/factory/");
    expect(settings.server?.proxy?.["/factory"]).toBeUndefined();
    expect(settings.server?.proxy?.["/factory/assets"]).toBeUndefined();
    expect(settings.server?.proxy?.["/pair"]).toBeUndefined();
    expect(settings.define?.["import.meta.env.DEV_FACTORY_PAIR_PORT"]).toBe('"4773"');
    expect(readConfig("build").define?.["import.meta.env.DEV_FACTORY_PAIR_PORT"]).toBe("undefined");
  });
  it.each([
    "http://localhost:4773?token=secret",
    "http://localhost:4773/source",
    "ftp://localhost",
  ])("rejects a non-origin upstream: %s", (upstream) => {
    vi.stubEnv("FACTORY_UPSTREAM", upstream);
    expect(() => readConfig()).toThrow();
  });
  it("preserves disabled HMR and file watching", () => {
    vi.stubEnv("DISABLE_HMR", "true");
    expect(readConfig().server).toMatchObject({ hmr: false, watch: null });
  });
});
