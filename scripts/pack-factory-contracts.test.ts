import { assert, it } from "@effect/vitest";

import { makeFactoryPackManifest } from "./pack-factory-contracts.ts";

it("publishes built factory exports with Effect as an exact peer", () => {
  const sourceManifest = {
    name: "@t3tools/contracts",
    version: "0.0.52",
    private: true,
    type: "module",
    exports: {
      ".": { types: "./src/index.ts", import: "./src/index.ts" },
      "./settings": { types: "./src/settings.ts", import: "./src/settings.ts" },
    },
    dependencies: { effect: "catalog:" },
    devDependencies: { "@effect/vitest": "catalog:" },
  };
  const versions = { version: "0.0.52", effectVersion: "4.0.0-rc.115" };
  const manifest = makeFactoryPackManifest(versions);
  const fixtureManifest = makeFactoryPackManifest(versions, sourceManifest);

  assert.deepStrictEqual(manifest.exports["./factory"], {
    types: "./dist/factory.d.ts",
    import: "./dist/factory.js",
  });
  assert.deepStrictEqual(manifest.exports["./factoryRpc"], {
    types: "./dist/factoryRpc.d.ts",
    import: "./dist/factoryRpc.js",
  });
  assert.deepStrictEqual(manifest.exports["./rpc"], {
    types: "./dist/rpc.d.ts",
    import: "./dist/rpc.js",
  });
  assert.deepStrictEqual(manifest.exports["./environmentHttp"], {
    types: "./dist/environmentHttp.d.ts",
    import: "./dist/environmentHttp.js",
  });
  assert.deepStrictEqual(manifest.exports["./factoryRelayUrl"], {
    types: "./dist/factoryRelayUrl.d.ts",
    import: "./dist/factoryRelayUrl.js",
  });
  assert.equal(manifest.peerDependencies.effect, "4.0.0-rc.115");
  assert.equal(manifest.dependencies?.effect, undefined);
  assert.equal(fixtureManifest.dependencies?.effect, undefined);
  assert.equal(fixtureManifest.exports["."], undefined);
  assert.equal(fixtureManifest.exports["./settings"], undefined);
  assert.equal(fixtureManifest.peerDependencies["@effect/vitest"], undefined);
  assert.equal(sourceManifest.dependencies.effect, "catalog:");
});
