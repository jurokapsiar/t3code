import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Socket from "effect/unstable/socket/Socket";
import { makeFactoryTransport, factoryPairUrl } from "./transport";

const auth = {
  authenticated: true,
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie"],
    sessionCookieName: "t3_session",
  },
};
const environment = {
  environmentId: "factory-test",
  label: "Factory",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.45",
  orchestrationProtocolVersion: 2,
  factoryProtocolVersion: 1,
  capabilities: { repositoryIdentity: true, factory: true },
};
const config = {
  environment,
  auth: auth.auth,
  cwd: "/workspace",
  keybindingsConfigPath: "/keys.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/logs",
    localTracingEnabled: false,
    otlpTracesUrl: null,
    otlpTracesEnabled: false,
    otlpMetricsUrl: null,
    otlpMetricsEnabled: false,
    otlpLogsUrl: null,
    otlpLogsEnabled: false,
  },
  settings: {},
};

function harness(
  options: {
    auth?: unknown;
    status?: number;
    failSocket?: boolean;
    config?: unknown;
    descriptor?: unknown;
    disconnectOnFactoryRequest?: boolean;
  } = {},
) {
  const requests: string[] = [];
  const sockets: FakeSocket[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    requests.push(path);
    expect(init?.credentials).toBe("same-origin");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (path === "/api/auth/session") {
      return Response.json(options.auth ?? auth, { status: options.status ?? 200 });
    }
    if (path === "/.well-known/t3/environment")
      return Response.json(options.descriptor ?? environment);
    throw new Error(`Unexpected request: ${path}`);
  };
  class FakeSocket implements Socket.WebSocketLike {
    readyState = 0;
    closed = false;
    readonly tags: string[] = [];
    readonly listeners = new Map<string, Set<(event: Socket.WebSocketEvent) => void>>();
    constructor(readonly url: string) {
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit(options.failSocket ? "error" : "open", {});
      });
    }
    emit(type: string, event: Socket.WebSocketEvent) {
      this.listeners.get(type)?.forEach((listener) => listener(event));
    }
    addEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)?.add(listener);
    }
    removeEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) {
      this.listeners.get(type)?.delete(listener);
    }
    close() {
      this.closed = true;
    }
    send(data: string | Uint8Array<ArrayBuffer>) {
      const request = JSON.parse(String(data));
      if (request._tag !== "Request") return;
      this.tags.push(request.tag);
      if (request.tag !== "server.getConfig" && options.disconnectOnFactoryRequest) {
        queueMicrotask(() => this.emit("close", { code: 1006, reason: "Connection lost" }));
        return;
      }
      queueMicrotask(() =>
        this.emit("message", {
          data: JSON.stringify({
            _tag: "Exit",
            requestId: request.id,
            exit: {
              _tag: "Success",
              value: request.tag === "server.getConfig" ? (options.config ?? config) : [],
            },
          }),
        }),
      );
    }
  }
  return {
    requests,
    sockets,
    options: {
      origin: "https://factory.test",
      fetch: fetcher,
      webSocketConstructor: (url: string) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    },
  };
}

describe("one-attempt factory transport", () => {
  it.live("blocks unauthenticated browsers before opening a socket", () =>
    Effect.gen(function* () {
      const h = harness({ auth: { ...auth, authenticated: false } });
      const exit = yield* Effect.exit(Effect.scoped(makeFactoryTransport(h.options)));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
        reason: "unauthenticated",
      });
      expect(h.requests).toEqual(["/api/auth/session"]);
      expect(h.sockets).toHaveLength(0);
    }),
  );
  it.live.each([401, 403])("treats HTTP %s as authentication rejection", (status) =>
    Effect.gen(function* () {
      const h = harness({ status });
      const exit = yield* Effect.exit(Effect.scoped(makeFactoryTransport(h.options)));
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
        reason: "unauthenticated",
      });
      expect(h.sockets).toHaveLength(0);
    }),
  );
  it.live.each([{ authenticated: "true" }, { nope: true }])(
    "rejects malformed auth instead of proceeding: %j",
    (value) =>
      Effect.gen(function* () {
        const h = harness({ auth: value });
        const exit = yield* Effect.exit(Effect.scoped(makeFactoryTransport(h.options)));
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          reason: "invalid-auth-session",
        });
        expect(h.sockets).toHaveLength(0);
      }),
  );
  it.live("surfaces HTTP failure without opening a socket", () =>
    Effect.gen(function* () {
      const h = harness({ status: 500 });
      const exit = yield* Effect.exit(Effect.scoped(makeFactoryTransport(h.options)));
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
        reason: "auth-check-failed",
      });
      expect(h.sockets).toHaveLength(0);
    }),
  );
  it.live.each([{ nope: true }, { ...environment, orchestrationProtocolVersion: undefined }])(
    "rejects invalid discovery before socket setup: %j",
    (descriptor) =>
      Effect.gen(function* () {
        const h = harness({ descriptor });
        const exit = yield* Effect.exit(Effect.scoped(makeFactoryTransport(h.options)));
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          reason: "invalid-discovery",
        });
        expect(h.sockets).toHaveLength(0);
      }),
  );
  it.live("surfaces a malformed config instead of readiness", () =>
    Effect.gen(function* () {
      const h = harness({ config: { environment } });
      expect(
        Exit.isFailure(yield* Effect.exit(Effect.scoped(makeFactoryTransport(h.options)))),
      ).toBe(true);
    }),
  );
  it.live("does not retry a failed socket", () =>
    Effect.gen(function* () {
      const h = harness({ failSocket: true });
      const exit = yield* Effect.exit(Effect.scoped(makeFactoryTransport(h.options)));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(h.sockets).toHaveLength(1);
      expect(h.sockets[0].closed).toBe(true);
    }),
  );
  it.live("reads config before readiness and shares one cookie socket with factory RPC", () =>
    Effect.gen(function* () {
      const h = harness();
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* makeFactoryTransport(h.options);
          expect(h.sockets[0].tags).toEqual(["server.getConfig"]);
          return yield* transport.factory["factory.environments.list"]({});
        }),
      );
      expect(result).toEqual([]);
      expect(h.requests).toEqual(["/api/auth/session", "/.well-known/t3/environment"]);
      expect(h.sockets).toHaveLength(1);
      expect(h.sockets[0].url).toBe("wss://factory.test/ws?orchestrationProtocol=2");
      expect(h.sockets[0].closed).toBe(true);
    }),
  );
  it.live.each([
    [false, 1, "factory-disabled"],
    [true, 2, "incompatible-protocol"],
  ] as const)("blocks config capability %s / %s", ([enabled, version, reason]) =>
    Effect.gen(function* () {
      const h = harness({
        config: {
          ...config,
          environment: {
            ...environment,
            capabilities: { repositoryIdentity: true, factory: enabled },
            factoryProtocolVersion: version,
          },
        },
      });
      const exit = yield* Effect.exit(Effect.scoped(makeFactoryTransport(h.options)));
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ reason });
      expect(h.sockets[0].tags).toEqual(["server.getConfig"]);
    }),
  );
  it.live("does not reconnect or replay a mutation after connection loss", () =>
    Effect.gen(function* () {
      const h = harness({ disconnectOnFactoryRequest: true });
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* makeFactoryTransport(h.options);
            return yield* transport.factory["factory.groups.create"]({ name: "Team" });
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(h.sockets).toHaveLength(1);
      expect(h.sockets[0].tags).toEqual(["server.getConfig", "factory.groups.create"]);
      expect(h.sockets[0].closed).toBe(true);
    }),
  );
});

describe("canonical pairing link", () => {
  it("uses production /pair without copying page secrets or selection", () => {
    expect(factoryPairUrl("https://factory.test/path?token=secret#thread")).toBe(
      "https://factory.test/pair",
    );
  });
  it("uses the factory port for development pairing, not Vite assets", () => {
    expect(factoryPairUrl("http://localhost:3000", "3773")).toBe("http://localhost:3773/pair");
  });
  it.each([
    "http://localhost:3773?token=secret",
    "http://user:secret@localhost:3773",
    "https://source.test",
  ])("rejects unsafe dev pairing port %s", (value) => {
    expect(() => factoryPairUrl("http://localhost:3000", value)).toThrow();
  });
});
