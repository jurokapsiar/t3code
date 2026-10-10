import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessExecutablePath, HostProcessIsExecutable } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveFactoryUiDir, resolveStaticDir } from "./config.ts";

it.layer(NodeServices.layer)("bundled UI discovery", (it) => {
  it.effect("prefers the installed Factory bundle over the repository build, not cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ui-discovery-" });
      const moduleDir = path.join(root, "apps/server/dist");
      const bundled = path.join(moduleDir, "factory");
      const repoBuild = path.join(root, "apps/factory/dist");
      for (const directory of [bundled, repoBuild]) {
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(path.join(directory, "index.html"), "Factory");
      }
      expect(yield* resolveFactoryUiDir(moduleDir)).toBe(bundled);
      yield* fs.remove(bundled, { recursive: true });
      expect(yield* resolveFactoryUiDir(moduleDir)).toBe(repoBuild);
      yield* fs.remove(repoBuild, { recursive: true });
      expect(yield* resolveFactoryUiDir(moduleDir)).toBeUndefined();
    }),
  );

  it.effect("finds repository builds when running the server from source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-source-ui-" });
      const directory = path.join(root, "apps/factory/dist");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "index.html"), "Factory");
      expect(yield* resolveFactoryUiDir(path.join(root, "apps/server/src"))).toBe(directory);
    }),
  );

  it.effect("uses the SEA executable directory for both shipped clients", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sea-ui-" });
      for (const name of ["client", "factory"]) {
        yield* fs.makeDirectory(path.join(root, name));
        yield* fs.writeFileString(path.join(root, name, "index.html"), name);
      }
      const discovery = Effect.gen(function* () {
        expect(yield* resolveStaticDir("/unrelated/node/source")).toBe(path.join(root, "client"));
        expect(yield* resolveFactoryUiDir("/unrelated/node/source")).toBe(
          path.join(root, "factory"),
        );
        yield* fs.remove(path.join(root, "factory"), { recursive: true });
        expect(yield* resolveFactoryUiDir("/unrelated/node/source")).toBeUndefined();
      }).pipe(
        Effect.provideService(HostProcessIsExecutable, true),
        Effect.provideService(HostProcessExecutablePath, path.join(root, "t3")),
      );
      yield* discovery;
    }),
  );
});
