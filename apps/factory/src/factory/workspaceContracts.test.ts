import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { FactoryOverviewSnapshot } from "@t3tools/contracts/factory";
import { WsRpcGroup } from "@t3tools/contracts/rpc";
import { FactoryRpcGroup } from "@t3tools/contracts/factoryRpc";

const decodeOverview = Schema.decodeUnknownSync(FactoryOverviewSnapshot);

describe("shared workspace contracts", () => {
  it("decodes factory wire data with the same Effect runtime as its RPC schemas", () => {
    const consumer = NodeModule.createRequire(import.meta.url);
    const contractsPath = NodeURL.fileURLToPath(import.meta.resolve("@t3tools/contracts/factory"));
    const producer = NodeModule.createRequire(contractsPath);
    expect(NodeFS.realpathSync(consumer.resolve("effect"))).toBe(
      NodeFS.realpathSync(producer.resolve("effect")),
    );
    expect(NodeFS.realpathSync(contractsPath)).toBe(
      NodeFS.realpathSync(
        NodeURL.fileURLToPath(
          new URL("../../../../packages/contracts/src/factory.ts", import.meta.url),
        ),
      ),
    );
    expect(FactoryRpcGroup.requests.size).toBeGreaterThan(0);
    expect(WsRpcGroup.requests.size).toBeGreaterThan(0);
    expect(() => decodeOverview({})).toThrow();
  });
});
