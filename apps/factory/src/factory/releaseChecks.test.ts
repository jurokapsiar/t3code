import { describe, expect, it } from "vite-plus/test";
import { checkInitialBundleBudget, forbiddenProductionModuleIds } from "./releaseChecks";

describe("checkInitialBundleBudget", () => {
  it("accepts growth at the 150 KiB limit", () => {
    expect(
      checkInitialBundleBudget({
        baselineGzipBytes: 100_000,
        currentGzipBytes: 100_000 + 150 * 1024,
      }),
    ).toEqual({ ok: true, growthBytes: 150 * 1024 });
  });

  it("rejects growth one byte above the 150 KiB limit", () => {
    expect(
      checkInitialBundleBudget({
        baselineGzipBytes: 100_000,
        currentGzipBytes: 100_000 + 150 * 1024 + 1,
      }),
    ).toEqual({ ok: false, reason: "initial-bundle-too-large", growthBytes: 150 * 1024 + 1 });
  });
});

it("rejects rendered application fixtures and test helpers from every emitted chunk", () => {
  expect(
    forbiddenProductionModuleIds([
      { id: "/ui/src/factory/testkit/productionClient.ts", renderedLength: 10 },
      { id: "/ui/src/factory/fixture.ts", renderedLength: 1 },
      { id: "/ui/src/mock/data.ts", renderedLength: 2 },
      { id: "/ui/src/factory/FactoryConnection.test.ts", renderedLength: 3 },
      { id: "/ui/src/factory/fixture.ts", renderedLength: 0 },
      { id: "/ui/src/factory/FactoryConnection.ts", renderedLength: 10 },
      { id: "/ui/node_modules/vendor/fixture.ts", renderedLength: 10 },
    ]),
  ).toEqual([
    "/ui/src/factory/testkit/productionClient.ts",
    "/ui/src/factory/fixture.ts",
    "/ui/src/mock/data.ts",
    "/ui/src/factory/FactoryConnection.test.ts",
  ]);
});

it("rejects exact underscored helper directory segments, but not similarly named production modules", () => {
  const forbidden = ["__fixtures__", "__mocks__", "__tests__", "fixtures", "mocks", "testkit"];
  const ids = forbidden.map((segment) => `/ui/src/factory/${segment}/helper.ts`);
  expect(
    forbiddenProductionModuleIds([
      ...ids.map((id) => ({ id, renderedLength: 1 })),
      { id: "/ui/src/factory/__fixtures__/unused.ts", renderedLength: 0 },
      { id: "/ui/src/factory/fixturePolicy.ts", renderedLength: 1 },
      { id: "/ui/src/factory/my-fixtures/helper.ts", renderedLength: 1 },
      { id: "/ui/src/factory/__tests__extra/helper.ts", renderedLength: 1 },
      { id: "/ui/node_modules/vendor/__tests__/helper.ts", renderedLength: 1 },
    ]),
  ).toEqual(ids);
});
