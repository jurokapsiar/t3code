import { describe, expect, it, vi } from "vite-plus/test";
import { FactoryFrameTarget } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  activateFactoryEmbed,
  resolveFactoryEmbedHandshakeMessage,
  isFactoryEmbedEndpoint,
  parseFactoryEmbedRoute,
  subscribeFactoryEmbedTarget,
  validateFactoryFrameInit,
  waitForFactoryFrameInit,
} from "./factoryEmbed";

const target = Schema.decodeSync(FactoryFrameTarget)({
  registrationId: "registration-a",
  environmentId: "source-a",
  threadId: "thread-a",
});

function fakeFrameWindow() {
  const events = new EventTarget();
  const parent = {} as Window;
  const host = {
    parent,
    location: { origin: "https://factory.test" },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    setTimeout,
    clearTimeout,
  } as unknown as Window;
  return { host, parent, events };
}

describe("factory embedded routes", () => {
  it("rejects endpoints outside the factory origin", () => {
    expect(
      isFactoryEmbedEndpoint({
        origin: "https://factory.test",
        endpoint: "https://source.test/ws",
      }),
    ).toBe(false);
  });

  it("accepts only the same-origin factory relay endpoint", () => {
    expect(
      isFactoryEmbedEndpoint({
        origin: "https://factory.test",
        endpoint: "wss://factory.test/factory/env/registration-a/ws",
      }),
    ).toBe(true);
    expect(
      isFactoryEmbedEndpoint({
        origin: "https://factory.test",
        endpoint: "wss://factory.test/ws",
      }),
    ).toBe(false);
    expect(
      isFactoryEmbedEndpoint({
        origin: "https://user@factory.test/untrusted",
        endpoint: "wss://factory.test/factory/env/registration-a/ws",
      }),
    ).toBe(false);
  });

  it("parses the existing environment/thread route and binds its registration", () => {
    expect(
      parseFactoryEmbedRoute(
        "https://factory.test/source-a/thread-a?factoryEmbedded=1&factoryRegistrationId=registration-a",
      ),
    ).toEqual({ target });
    expect(
      parseFactoryEmbedRoute(
        "https://factory.test/source-b/thread-a?factoryEmbedded=1&factoryRegistrationId=registration-a",
      )?.target,
    ).not.toEqual(target);
    expect(
      parseFactoryEmbedRoute(
        "https://factory.test/source-a/thread-a?factoryEmbedded=1&factoryRegistrationId=registration-a&token=secret",
      ),
    ).toBeNull();
  });

  it("validates the init schema, same-origin parent, sender, and full source/thread target", () => {
    const parent = {} as MessageEventSource;
    const base = {
      data: { _tag: "init", version: 1, target },
      origin: "https://factory.test",
      source: parent,
      parent,
      expectedOrigin: "https://factory.test",
      routeTarget: target,
    };
    expect(validateFactoryFrameInit(base)).toEqual(base.data);
    expect(validateFactoryFrameInit({ ...base, source: {} as MessageEventSource })).toBeNull();
    expect(validateFactoryFrameInit({ ...base, origin: "https://other.test" })).toBeNull();
    expect(
      validateFactoryFrameInit({
        ...base,
        data: { _tag: "init", version: 1, target: { ...target, registrationId: "other" } },
      }),
    ).toBeNull();
    expect(
      validateFactoryFrameInit({ ...base, data: { _tag: "init", version: 2, target } }),
    ).toBeNull();
  });

  it("bounds init waiting and accepts only a valid parent init message", async () => {
    vi.useFakeTimers();
    try {
      const timeoutFrame = fakeFrameWindow();
      const timedOut = waitForFactoryFrameInit(target, timeoutFrame.host, 25);
      const timeoutAssertion = expect(timedOut).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(25);
      await timeoutAssertion;

      const frame = fakeFrameWindow();
      const accepted = waitForFactoryFrameInit(target, frame.host, 100);
      const event = Object.assign(new Event("message"), {
        origin: "https://factory.test",
        source: frame.parent,
        data: { _tag: "init", version: 1, target },
      }) as MessageEvent;
      frame.events.dispatchEvent(event);
      await expect(accepted).resolves.toMatchObject({ target, version: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the matching live connection and thread before ready", () => {
    const base = {
      expectedTarget: target,
      activeTarget: target,
      routeTarget: { environmentId: target.environmentId, threadId: target.threadId },
      connectionPhase: "connected" as const,
      threadState: "ready" as const,
    };
    expect(
      resolveFactoryEmbedHandshakeMessage({ ...base, connectionPhase: "connecting" }),
    ).toBeNull();
    expect(resolveFactoryEmbedHandshakeMessage({ ...base, threadState: "pending" })).toBeNull();
    expect(resolveFactoryEmbedHandshakeMessage(base)).toEqual({
      _tag: "ready",
      version: 1,
      target,
    });
  });

  it("reports route and source failures instead of accepting a replacement target", () => {
    const base = {
      expectedTarget: target,
      activeTarget: { ...target, registrationId: "registration-b" } as typeof target,
      routeTarget: { environmentId: target.environmentId, threadId: target.threadId },
      connectionPhase: "connected" as const,
      threadState: "ready" as const,
    };
    expect(resolveFactoryEmbedHandshakeMessage(base)).toMatchObject({
      _tag: "error",
      code: "target-mismatch",
    });
    expect(
      resolveFactoryEmbedHandshakeMessage({
        ...base,
        activeTarget: target,
        threadState: "missing",
      }),
    ).toMatchObject({ _tag: "error", code: "thread-unavailable" });
    expect(
      resolveFactoryEmbedHandshakeMessage({
        ...base,
        activeTarget: target,
        failureCode: "source-authentication",
      }),
    ).toMatchObject({ _tag: "error", code: "source-authentication" });
  });

  it("reports a source disconnect after it has reported ready", () => {
    expect(
      resolveFactoryEmbedHandshakeMessage({
        expectedTarget: target,
        activeTarget: target,
        routeTarget: { environmentId: target.environmentId, threadId: target.threadId },
        connectionPhase: "disconnected",
        threadState: "ready",
        alreadyReady: true,
      }),
    ).toMatchObject({ _tag: "error", code: "source-unavailable" });
  });

  it("publishes a late embedded target to an already-started platform source", () => {
    const changes: Array<typeof target | null> = [];
    const unsubscribe = subscribeFactoryEmbedTarget((next) => changes.push(next));
    const deactivate = activateFactoryEmbed(target);

    expect(changes).toEqual([null, target]);
    deactivate();
    expect(changes).toEqual([null, target, null]);
    unsubscribe();
  });
});
