import {
  type ConnectionCatalogEntry,
  EnvironmentRegistry,
  type NetworkStatus,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  backgroundActivityReporterLayer,
  observeBackgroundActivitySubscription,
  retainedBackgroundScopes,
  wasRecentlyInteracted,
} from "./backgroundActivityReporter.ts";

describe("wasRecentlyInteracted", () => {
  it("expires interaction independently of window focus", () => {
    expect(wasRecentlyInteracted(10_000, 55_000)).toBe(true);
    expect(wasRecentlyInteracted(10_000, 55_001)).toBe(false);
  });

  it("rejects future timestamps", () => {
    expect(wasRecentlyInteracted(10_001, 10_000)).toBe(false);
  });

  it.effect("retains an observed subscription until its returned finalizer runs", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-observation-test");
      const scope = { type: "vcs-status" as const, cwd: "/repo" };
      const release = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd },
      });

      expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

      yield* release;
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("keeps delimiter-containing environment and scope values distinct", () =>
    Effect.gen(function* () {
      const firstEnvironmentId = EnvironmentId.make("a");
      const secondEnvironmentId = EnvironmentId.make("a:vcs-status:b");
      const releaseFirst = yield* observeBackgroundActivitySubscription({
        environmentId: firstEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "b:vcs-status:c" },
      });
      const releaseSecond = yield* observeBackgroundActivitySubscription({
        environmentId: secondEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "c" },
      });

      expect(retainedBackgroundScopes(firstEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "b:vcs-status:c" },
      ]);
      expect(retainedBackgroundScopes(secondEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "c" },
      ]);

      yield* Effect.all([releaseFirst, releaseSecond]);
    }),
  );
});

describe("backgroundActivityReporterLayer", () => {
  // Presence is environment-wide, so a Factory relay scoped to one thread
  // rejects it and closes the embedded chat.
  const reportsAfterStartup = (href: string) =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-presence-test");
      const entry: ConnectionCatalogEntry = {
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Presence test",
          httpBaseUrl: "https://source.example.test",
          wsBaseUrl: "wss://source.example.test",
        }),
        profile: Option.none(),
        enabled: true,
      };
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map([[environmentId, entry]]));
      const reported: EnvironmentId[] = [];
      const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
      const registry = Layer.mock(EnvironmentRegistry.EnvironmentRegistry, {
        entries,
        networkStatus,
        run: (id) =>
          Effect.sync(() => reported.push(id)).pipe(
            Effect.andThen(
              Effect.fail(
                new EnvironmentRegistry.EnvironmentNotRegisteredError({ environmentId: id }),
              ),
            ),
          ),
      });
      const listeners = { addEventListener: () => {}, removeEventListener: () => {} };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          vi.stubGlobal("window", { ...listeners, location: { href } });
          vi.stubGlobal("document", {
            ...listeners,
            visibilityState: "visible",
            hasFocus: () => true,
          });
        }),
        () => Effect.sync(() => vi.unstubAllGlobals()),
      );
      yield* Layer.build(backgroundActivityReporterLayer.pipe(Layer.provide(registry)));
      yield* TestClock.adjust("1 second");
      return reported;
    }).pipe(Effect.scoped);

  it.effect("reports presence for a normal client but not inside an embedded Factory chat", () =>
    Effect.gen(function* () {
      expect(yield* reportsAfterStartup("https://app.example/thread")).toHaveLength(1);
      expect(
        yield* reportsAfterStartup("https://factory.example/env/thread?factoryEmbedded=1"),
      ).toEqual([]);
    }),
  );
});
