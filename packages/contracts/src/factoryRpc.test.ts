import { describe, expect, it } from "vite-plus/test";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";
import * as Schema from "effect/Schema";

import { AuthSourceMethodScope } from "./auth.ts";
import { FactoryEnvironmentView } from "./factory.ts";
import {
  FactoryEnvironmentsEnrollRpc,
  FactoryRelayScope,
  FactoryRpcGroup,
  FactoryRpcMethodScopes,
} from "./factoryRpc.ts";

const decodeFactoryRelayScope = Schema.decodeSync(FactoryRelayScope);
const decodeEnrollmentInput = Schema.decodeSync(FactoryEnvironmentsEnrollRpc.payloadSchema);
const decodeEnrollmentInputExit = Schema.decodeUnknownExit(
  FactoryEnvironmentsEnrollRpc.payloadSchema,
);

describe("FactoryRpcGroup", () => {
  it("requires administrator scope for an explicit source reconnect", () => {
    expect(FactoryRpcGroup.requests.has("factory.environments.retry")).toBe(true);
    expect(
      Object.entries(FactoryRpcMethodScopes).find(
        ([method]) => method === "factory.environments.retry",
      )?.[1],
    ).toBe("factory:admin");
  });

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

  it("accepts a short-lived credential only as enrollment input", () => {
    const input = {
      endpoint: "https://source.example",
      label: "Source",
      sourceCredential: "short-lived-credential",
    };
    expect(decodeEnrollmentInput(input)).toEqual(input);
    expect("sourceCredential" in FactoryEnvironmentView.fields).toBe(false);
    expect("token" in FactoryEnvironmentView.fields).toBe(false);
    expect(
      decodeEnrollmentInputExit({ endpoint: input.endpoint, label: input.label }),
    ).toMatchObject({ _tag: "Failure" });
  });

  it("uses a streaming overview", () => {
    const overview = FactoryRpcGroup.requests.get("factory.overview.subscribe");
    if (overview === undefined) throw new Error("Overview RPC declaration is missing");

    expect(RpcSchema.isStreamSchema(overview.successSchema)).toBe(true);
  });
});
