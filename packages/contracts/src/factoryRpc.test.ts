import { describe, expect, it } from "vite-plus/test";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";
import * as Schema from "effect/Schema";

import { AuthSourceMethodScope } from "./auth.ts";
import { FactoryRelayScope, FactoryRpcGroup, FactoryRpcMethodScopes } from "./factoryRpc.ts";

const decodeFactoryRelayScope = Schema.decodeSync(FactoryRelayScope);

describe("FactoryRpcGroup", () => {
  it("declares factory-owned metadata, enrollment, favorites, and overview methods", () => {
    const requests = FactoryRpcGroup.requests;

    expect([...requests.keys()]).toEqual(
      expect.arrayContaining([
        "factory.environments.list",
        "factory.environments.enroll",
        "factory.environments.update",
        "factory.environments.remove",
        "factory.groups.list",
        "factory.groups.create",
        "factory.groups.update",
        "factory.groups.delete",
        "factory.groups.assign",
        "factory.groups.unassign",
        "factory.favorites.set",
        "factory.favorites.reorder",
        "factory.overview.subscribe",
      ]),
    );
    expect([...requests.keys()].some((method) => method.startsWith("orchestrationV2."))).toBe(
      false,
    );
  });

  it("requires factory scopes for owned operations and preserves source relay scopes", () => {
    expect(FactoryRpcMethodScopes["factory.environments.enroll"]).toBe("factory:admin");
    expect(FactoryRpcMethodScopes["factory.groups.create"]).toBe("factory:control");
    expect(FactoryRpcMethodScopes["factory.overview.subscribe"]).toBe("factory:read");
    for (const scope of AuthSourceMethodScope.literals) {
      expect(decodeFactoryRelayScope(scope)).toBe(scope);
    }
  });

  it("uses typed, secret-free enrollment input and a streaming overview", () => {
    const enroll = FactoryRpcGroup.requests.get("factory.environments.enroll");
    const overview = FactoryRpcGroup.requests.get("factory.overview.subscribe");
    if (enroll === undefined || overview === undefined) {
      throw new Error("Required factory RPC declarations are missing");
    }

    expect("sourceCredential" in enroll.payloadSchema.fields).toBe(false);
    expect("token" in enroll.payloadSchema.fields).toBe(false);
    expect(RpcSchema.isStreamSchema(overview.successSchema)).toBe(true);
  });
});
