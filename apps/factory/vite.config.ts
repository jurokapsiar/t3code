import react from "@vitejs/plugin-react";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import "vite-plus/test/config";
import { defineConfig, loadEnv } from "vite-plus";

const workspaceRequire = NodeModule.createRequire(new URL("../../package.json", import.meta.url));

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), "FACTORY_");
  const upstream = new URL(env.FACTORY_UPSTREAM ?? "http://localhost:3773");
  if (
    !["http:", "https:"].includes(upstream.protocol) ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    upstream.pathname !== "/"
  ) {
    throw new Error("FACTORY_UPSTREAM must be a non-secret HTTP origin");
  }
  const target = upstream.origin;
  return {
    base: command === "build" ? "/factory/" : "/",
    plugins: [react()],
    define: {
      ...(command === "serve" && mode === "mock"
        ? { "import.meta.env.VITE_FACTORY_FIXTURE": JSON.stringify("1") }
        : {}),
      "import.meta.env.DEV_FACTORY_PAIR_PORT":
        command === "serve"
          ? JSON.stringify(upstream.port || (upstream.protocol === "https:" ? "443" : "80"))
          : "undefined",
    },
    resolve: {
      alias: {
        "@": NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      },
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
      // Optional tool peers create a second Vite+ copy; tests and the Effect bridge share the root runner.
      alias: [
        {
          find: /^vite-plus\/test$/,
          replacement: workspaceRequire.resolve("vite-plus/test").replace(/\.cjs$/, ".js"),
        },
      ],
    },
    server: {
      proxy: {
        "/ws": { target, ws: true },
        "/api": { target },
        "/factory/bootstrap": { target, changeOrigin: true, xfwd: true },
        "/factory/env": { target, ws: true, changeOrigin: true, xfwd: true },
        "/oauth": { target },
        "/.well-known": { target },
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== "true",
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === "true" ? null : {},
    },
  };
});
