import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { stageServerUiAssets } from "./server-ui-assets.ts";

it.layer(NodeServices.layer)("server UI packaging", (it) => {
  it.effect("copies both clients and strips nested source maps only for archives", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-package-ui-" });
      const webDist = path.join(root, "web");
      const factoryDist = path.join(root, "factory");
      for (const source of [webDist, factoryDist]) {
        yield* fs.makeDirectory(path.join(source, "assets"), { recursive: true });
        yield* fs.writeFileString(path.join(source, "index.html"), source);
        yield* fs.writeFileString(path.join(source, "assets/main.js"), "javascript");
        yield* fs.writeFileString(path.join(source, "assets/main.js.map"), "source map");
      }
      for (const stripSourceMaps of [false, true]) {
        const targetDir = path.join(root, stripSourceMaps ? "archive" : "dist");
        yield* stageServerUiAssets({ webDist, factoryDist, targetDir, stripSourceMaps });
        for (const [name, source] of [
          ["client", webDist],
          ["factory", factoryDist],
        ] as const) {
          expect(yield* fs.readFileString(path.join(targetDir, name, "index.html"))).toBe(source);
          expect(yield* fs.readFileString(path.join(targetDir, name, "assets/main.js"))).toBe(
            "javascript",
          );
          expect(yield* fs.exists(path.join(targetDir, name, "assets/main.js.map"))).toBe(
            !stripSourceMaps,
          );
        }
      }
    }),
  );

  it.effect(
    "fails explicitly if either build is missing instead of shipping a partial bundle",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-package-ui-missing-" });
        const webDist = path.join(root, "web");
        const factoryDist = path.join(root, "factory");
        yield* fs.makeDirectory(webDist);
        yield* fs.writeFileString(path.join(webDist, "index.html"), "T3");
        const targetDir = path.join(root, "archive");
        const error = yield* stageServerUiAssets({ webDist, factoryDist, targetDir }).pipe(
          Effect.flip,
        );
        expect(error).toMatchObject({ _tag: "ServerUiBuildMissingError", directory: factoryDist });
        expect(yield* fs.exists(path.join(targetDir, "client"))).toBe(false);
        yield* fs.remove(path.join(webDist, "index.html"));
        yield* fs.makeDirectory(factoryDist);
        yield* fs.writeFileString(path.join(factoryDist, "index.html"), "Factory");
        const webError = yield* stageServerUiAssets({ webDist, factoryDist, targetDir }).pipe(
          Effect.flip,
        );
        expect(webError).toMatchObject({ _tag: "ServerUiBuildMissingError", directory: webDist });
      }),
  );
});
