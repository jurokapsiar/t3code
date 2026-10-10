// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { extractFile } from "@electron/asar";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { createBuildConfig, packWindowsServerAsar } from "./build-desktop-artifact.ts";
import { stageServerUiAssets } from "./lib/server-ui-assets.ts";

const decodeFiles = Schema.decodeUnknownEffect(
  Schema.Struct({ files: Schema.Array(Schema.String) }),
);

it.layer(NodeServices.layer)("desktop Factory packaging", (it) => {
  it.effect("keeps Factory entry and chunks in macOS and Linux desktop payloads", () =>
    Effect.gen(function* () {
      for (const platform of ["mac", "linux"] as const) {
        const config = yield* createBuildConfig(
          platform,
          platform === "mac" ? "dmg" : "AppImage",
          "1.2.3",
          false,
          false,
          undefined,
          undefined,
        ).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))));
        const { files } = yield* decodeFiles(config);
        for (const member of [
          "apps/server/dist/factory/index.html",
          "apps/server/dist/factory/assets/main.js",
        ]) {
          expect(
            files.some(
              (glob) => glob.startsWith("!") && NodePath.matchesGlob(member, glob.slice(1)),
            ),
          ).toBe(false);
        }
      }
    }),
  );

  it.effect("carries the built Factory app inside the Windows server ASAR", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-factory-" });
      const webDist = path.join(root, "web");
      const factoryDist = path.join(root, "factory");
      for (const directory of [webDist, factoryDist]) {
        yield* fs.makeDirectory(path.join(directory, "assets"), { recursive: true });
        yield* fs.writeFileString(path.join(directory, "index.html"), "Factory entry");
        yield* fs.writeFileString(path.join(directory, "assets/main.js"), "Factory chunk");
      }
      const sourceDir = path.join(root, "server");
      yield* stageServerUiAssets({
        webDist,
        factoryDist,
        targetDir: path.join(sourceDir, "apps/server/dist"),
      });
      yield* fs.makeDirectory(path.join(sourceDir, "node_modules/native"), { recursive: true });
      yield* fs.writeFileString(path.join(sourceDir, "node_modules/native/addon.node"), "native");
      const asarPath = path.join(root, "server.asar");
      yield* packWindowsServerAsar({ sourceDir, asarPath, arch: "x64" });
      expect(
        yield* Effect.sync(() =>
          extractFile(asarPath, "apps/server/dist/factory/index.html").toString(),
        ),
      ).toBe("Factory entry");
      expect(
        yield* Effect.sync(() =>
          extractFile(asarPath, "apps/server/dist/factory/assets/main.js").toString(),
        ),
      ).toBe("Factory chunk");
    }),
  );
});
