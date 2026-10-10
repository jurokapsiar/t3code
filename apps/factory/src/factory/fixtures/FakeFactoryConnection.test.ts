import { resolveSourceHttpUrl, SourceHttpUrlError } from "@t3tools/contracts/factoryRelayUrl";
import { describe, expect, it } from "vite-plus/test";
import { createFakeFactoryConnection } from "./FakeFactoryConnection";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("development factory fixture", () => {
  it("emits contract snapshots and patches with simulated overview and metadata responses", async () => {
    const connection = createFakeFactoryConnection();
    const emitted: Array<{ readonly type: string }> = [];
    const complete = deferred<void>();
    const lease = connection.acquireStream(
      "fixture-overview",
      (client) => client["factory.overview.subscribe"]({}),
      (event) => {
        emitted.push(event);
        if (emitted.length === 5) complete.resolve(undefined);
      },
    );
    connection.start();
    try {
      await complete.promise;
      expect(connection.simulated).toBe(true);
      expect(emitted.map((event) => event.type)).toEqual([
        "snapshot",
        "patch",
        "patch",
        "patch",
        "patch",
      ]);
      expect(emitted[0]).toMatchObject({
        type: "snapshot",
        snapshot: {
          projects: expect.arrayContaining([
            expect.objectContaining({
              key: { environmentId: "fixture-environment", projectId: "fixture-empty-project" },
              title: "Simulated empty project",
            }),
          ]),
        },
      });
      expect(emitted[4]).toMatchObject({
        type: "patch",
        patch: {
          kind: "projects",
          upserts: [expect.objectContaining({ title: "Updated simulated empty project" })],
        },
      });
      const [environment] = await connection.request((client) =>
        client["factory.environments.list"]({}),
      );
      if (environment === undefined) throw new Error("Missing simulated environment");
      const admission = await connection.request((client) =>
        client["factory.source.controlAuthorization"]({
          target: {
            registrationId: environment.registrationId,
            environmentId: environment.environmentId,
          },
          operation: "launch",
        }),
      );
      expect(admission).toEqual({ allowed: false, reason: "source-unavailable" });
      const groups = await connection.request((client) => client["factory.groups.list"]({}));
      expect(environment?.label).toMatch(/^Simulated/);
      expect(groups.groups[0]?.name).toMatch(/^Simulated/);
      expect(environment).not.toHaveProperty("sourceCredential");
      const prefix = environment?.sourceAccess?.httpPrefix;
      expect(prefix).toBe("/factory/env/fixture-registration/");
      if (prefix === undefined) throw new Error("Missing fixture HTTP prefix");
      expect(
        resolveSourceHttpUrl(prefix, "/api/assets/signed/file.png", {
          mode: "factory-relay",
          environmentId: environment.environmentId,
        }),
      ).toBe(
        "/factory/env/fixture-registration/api/assets/signed/file.png?environmentId=fixture-environment",
      );
      expect(() =>
        resolveSourceHttpUrl(prefix, "https://source.test/api/assets/signed/file.png", {
          mode: "factory-relay",
        }),
      ).toThrow(SourceHttpUrlError);
      expect(environment).toMatchObject({
        sourceAccess: {
          websocketRoute: "/factory/env/fixture-registration/ws",
          httpPrefix: "/factory/env/fixture-registration/",
          capabilities: { websocket: true, http: true },
        },
      });
    } finally {
      lease.release();
      await connection.stop();
    }
  });
});
