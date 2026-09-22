import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  WsOpencodeListSessionsRpc,
  WsOpencodeReconcileThreadRpc,
  WsSubscribeServerConfigRpc,
} from "./rpc.ts";

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const oldServerPayload = Schema.Struct({});
    const decoded = Schema.decodeUnknownExit(oldServerPayload)({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = Schema.decodeUnknownSync(WsSubscribeServerConfigRpc.payloadSchema)({
      environmentThemes: true,
    });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = Schema.decodeUnknownSync(WsSubscribeServerConfigRpc.payloadSchema)({});
    expect(decoded).toEqual({});
  });
});

describe("opencode.listSessions", () => {
  it("decodes an instance and directory request", () => {
    const decoded = Schema.decodeUnknownSync(WsOpencodeListSessionsRpc.payloadSchema)({
      instanceId: "opencode",
      cwd: "/repo",
    });
    expect(decoded).toEqual({ instanceId: "opencode", cwd: "/repo" });
  });
});

describe("opencode.reconcileThread", () => {
  it("decodes a thread reconcile request", () => {
    const decoded = Schema.decodeUnknownSync(WsOpencodeReconcileThreadRpc.payloadSchema)({
      threadId: "thread-1",
    });
    expect(decoded).toEqual({ threadId: "thread-1" });
  });
});
