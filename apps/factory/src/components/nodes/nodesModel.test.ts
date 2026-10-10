import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { FactoryEnvironmentView } from "@t3tools/contracts/factory";
import * as nodesModel from "./nodesModel";
import {
  buildEnvironmentDetails,
  buildEnvironmentEdit,
  environmentStatusMessage,
  parseEnvironmentEndpoint,
} from "./nodesModel";

const environment = Schema.decodeUnknownSync(FactoryEnvironmentView)({
  registrationId: "registration-1",
  environmentId: "environment-1",
  endpoint: "https://source.example:4000",
  label: "Source",
  platform: null,
  enabled: true,
  state: "online",
  credentialStorage: null,
  credentialExpiresAt: null,
  renewal: "unsupported",
  lastSeenAt: null,
  revision: 4,
});

describe("Nodes view model", () => {
  it("builds a new node endpoint using the default T3 serve port", () => {
    expect(
      buildEnvironmentDetails({
        ...nodesModel.defaultEnvironmentAddress,
        label: "Local source",
      }),
    ).toEqual({
      ok: true,
      endpoint: "http://127.0.0.1:3773",
      label: "Local source",
    });
  });

  it.each([
    ["pending", true, "Registration is pending. The factory is connecting to this source."],
    ["blocked", true, "The factory blocked this source. Retry the connection or re-enroll it."],
    ["removing", false, "Removal is pending. The factory is cleaning up this registration."],
    ["offline", false, "This source is disabled. Enable it to reconnect."],
  ] as const)("describes %s without implying it is online", (state, enabled, expected) => {
    expect(environmentStatusMessage({ ...environment, state, enabled })).toBe(expected);
  });

  it("parses endpoint parts without moving the connection to a source origin", () => {
    expect(parseEnvironmentEndpoint("https://source.example:4000")).toEqual({
      scheme: "https",
      host: "source.example",
      port: "4000",
    });
    expect(parseEnvironmentEndpoint("file:///tmp/source")).toBeNull();
  });

  it("keeps an enrolled source endpoint fixed while editing its label", () => {
    const enrolled = { ...environment, credentialStorage: "secure-vault" as const };
    expect(
      buildEnvironmentEdit(enrolled, {
        scheme: "http",
        host: "127.0.0.1",
        port: "4001",
        label: "Local source",
      }),
    ).toEqual({
      ok: true,
      input: {
        registrationId: enrolled.registrationId,
        revision: 4,
        endpoint: enrolled.endpoint,
        label: "Local source",
      },
    });
  });

  it("allows endpoint edits before enrollment", () => {
    const pending = { ...environment, credentialStorage: null };
    expect(
      buildEnvironmentEdit(pending, {
        scheme: "http",
        host: "127.0.0.1",
        port: "4001",
        label: "Local source",
      }),
    ).toMatchObject({ ok: true, input: { endpoint: "http://127.0.0.1:4001" } });
  });

  it("rejects invalid edit ports without creating an action payload", () => {
    expect(
      buildEnvironmentEdit(environment, {
        scheme: "https",
        host: "source.example",
        port: "70000",
        label: "Source",
      }),
    ).toMatchObject({ ok: false });
  });
});
