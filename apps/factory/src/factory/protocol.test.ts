import { describe, expect, it } from "vite-plus/test";
import { FACTORY_PROTOCOL_VERSION } from "@t3tools/contracts/factory";
import { isFactoryCompatible, factoryPairUrl } from "./protocol";

describe("factory protocol capability", () => {
  it("requires an enabled factory and the installed protocol version", () => {
    expect(isFactoryCompatible({ enabled: false, protocolVersion: 1 }, 1)).toBe(false);
    expect(isFactoryCompatible({ enabled: true, protocolVersion: 2 }, 1)).toBe(false);
    expect(isFactoryCompatible({ enabled: true, protocolVersion: 1 }, 1)).toBe(true);
    expect(isFactoryCompatible({ enabled: true, protocolVersion: FACTORY_PROTOCOL_VERSION })).toBe(
      true,
    );
    expect(isFactoryCompatible(undefined)).toBe(false);
  });
});

describe("browser-reachable development pairing", () => {
  it.each([
    ["http://192.168.1.42:3000", "3773", "http://192.168.1.42:3773/pair"],
    ["http://localhost:3000", "4773", "http://localhost:4773/pair"],
    ["https://factory.example.test", undefined, "https://factory.example.test/pair"],
    ["http://[::1]:3000", "3773", "http://[::1]:3773/pair"],
  ])("keeps the browser host for %s", (origin, port, expected) => {
    expect(factoryPairUrl(origin, port)).toBe(expected);
  });
});
