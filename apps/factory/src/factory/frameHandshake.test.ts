import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { FactoryFrameMessage, FactoryFrameTarget } from "@t3tools/contracts/factory";
import { acceptFrameMessage, createFrameHandshake } from "./frameHandshake";
import { factoryKeys, frameTargetKey } from "./queryKeys";

const expectedTarget = Schema.decodeUnknownSync(FactoryFrameTarget)({
  registrationId: "registration-a",
  environmentId: "environment-a",
  threadId: "thread-a",
});
const message = Schema.decodeUnknownSync(FactoryFrameMessage)({
  _tag: "ready",
  version: 1,
  target: expectedTarget,
});

describe("acceptFrameMessage", () => {
  it("rejects messages from a different origin", () => {
    expect(
      acceptFrameMessage({
        origin: "https://wrong.test",
        expectedOrigin: "https://factory.test",
        sourceMatches: true,
        expectedTarget,
        message,
      }),
    ).toBe(false);
  });

  it("rejects messages from another frame window", () => {
    expect(
      acceptFrameMessage({
        origin: "https://factory.test",
        expectedOrigin: "https://factory.test",
        sourceMatches: false,
        expectedTarget,
        message,
      }),
    ).toBe(false);
  });

  it("rejects messages with an unsupported protocol version", () => {
    expect(
      acceptFrameMessage({
        origin: "https://factory.test",
        expectedOrigin: "https://factory.test",
        sourceMatches: true,
        expectedTarget,
        message: { ...message, version: 2 },
      }),
    ).toBe(false);
  });

  it("rejects another registration with the same local ids", () => {
    const otherSourceTarget = Schema.decodeUnknownSync(FactoryFrameTarget)({
      registrationId: "registration-b",
      environmentId: "environment-a",
      threadId: "thread-a",
    });
    const otherSourceMessage = Schema.decodeUnknownSync(FactoryFrameMessage)({
      _tag: "ready",
      version: 1,
      target: otherSourceTarget,
    });
    expect(
      acceptFrameMessage({
        origin: "https://factory.test",
        expectedOrigin: "https://factory.test",
        sourceMatches: true,
        expectedTarget,
        message: otherSourceMessage,
      }),
    ).toBe(false);
  });

  it("accepts a valid message for the exact frame target", () => {
    expect(
      acceptFrameMessage({
        origin: "https://factory.test",
        expectedOrigin: "https://factory.test",
        sourceMatches: true,
        expectedTarget,
        message,
      }),
    ).toBe(true);
  });

  it("keeps identical local ids separate across source registrations", () => {
    const otherSourceTarget = Schema.decodeUnknownSync(FactoryFrameTarget)({
      registrationId: "registration-b",
      environmentId: "environment-a",
      threadId: "thread-a",
    });
    expect(frameTargetKey(otherSourceTarget)).not.toBe(frameTargetKey(expectedTarget));
    expect(factoryKeys.embeddedRoute("factory-a", otherSourceTarget)).not.toEqual(
      factoryKeys.embeddedRoute("factory-a", expectedTarget),
    );
  });
});

describe("createFrameHandshake", () => {
  afterEach(() => vi.useRealTimers());

  it("sends a versioned init for the selected target on each frame load", () => {
    const sent: Array<{ readonly message: unknown; readonly targetOrigin: string }> = [];
    const handshake = createFrameHandshake({
      expectedOrigin: "https://factory.test",
      expectedTarget,
      timeoutMs: 1000,
      onReady: () => {},
      onError: () => {},
    });
    const send = (init: unknown, targetOrigin: string) =>
      sent.push({ message: init, targetOrigin });

    handshake.onFrameLoad(send);
    handshake.onFrameLoad(send);

    expect(sent).toEqual([
      {
        message: { _tag: "init", version: 1, target: expectedTarget },
        targetOrigin: "https://factory.test",
      },
      {
        message: { _tag: "init", version: 1, target: expectedTarget },
        targetOrigin: "https://factory.test",
      },
    ]);
    handshake.cancel();
  });

  it("cancels its timeout after an exact ready message", () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const onError = vi.fn();
    const handshake = createFrameHandshake({
      expectedOrigin: "https://factory.test",
      expectedTarget,
      timeoutMs: 1000,
      onReady,
      onError,
    });

    expect(
      handshake.onMessage({ origin: "https://factory.test", sourceMatches: true, message }),
    ).toBe(true);
    vi.advanceTimersByTime(1000);

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    handshake.cancel();
  });

  it("restarts the handshake when the selected frame reloads after ready", () => {
    const sent: Array<{ readonly message: unknown; readonly targetOrigin: string }> = [];
    const onReady = vi.fn();
    const handshake = createFrameHandshake({
      expectedOrigin: "https://factory.test",
      expectedTarget,
      timeoutMs: 1000,
      onReady,
      onError: () => {},
    });
    const send = (init: unknown, targetOrigin: string) =>
      sent.push({ message: init, targetOrigin });

    handshake.onFrameLoad(send);
    expect(
      handshake.onMessage({ origin: "https://factory.test", sourceMatches: true, message }),
    ).toBe(true);
    handshake.onFrameLoad(send);

    expect(sent).toHaveLength(2);
    expect(
      handshake.onMessage({ origin: "https://factory.test", sourceMatches: true, message }),
    ).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(2);
    handshake.cancel();
  });

  it("cancels message handling and timeout when the selected target is removed", () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const onError = vi.fn();
    const handshake = createFrameHandshake({
      expectedOrigin: "https://factory.test",
      expectedTarget,
      timeoutMs: 1000,
      onReady,
      onError,
    });
    handshake.cancel();
    vi.advanceTimersByTime(1000);

    expect(
      handshake.onMessage({ origin: "https://factory.test", sourceMatches: true, message }),
    ).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports the bounded timeout when the native session does not become ready", () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const handshake = createFrameHandshake({
      expectedOrigin: "https://factory.test",
      expectedTarget,
      timeoutMs: 1000,
      onReady: () => {},
      onError,
    });

    vi.advanceTimersByTime(999);
    expect(onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onError).toHaveBeenCalledWith("timeout");
    expect(
      handshake.onMessage({ origin: "https://factory.test", sourceMatches: true, message }),
    ).toBe(false);
    handshake.cancel();
  });

  it("invalidates ready on a validated lifecycle error, rejecting stale iframe identities", () => {
    vi.useFakeTimers();
    let state = "loading";
    const handshake = createFrameHandshake({
      expectedOrigin: "https://factory.test",
      expectedTarget,
      timeoutMs: 1000,
      onReady: () => {
        state = "ready";
      },
      onError: (code) => {
        state = code;
      },
    });
    const input = { origin: "https://factory.test", sourceMatches: true, message };
    expect(handshake.onMessage(input)).toBe(true);
    expect(state).toBe("ready");
    const failure = {
      _tag: "error",
      version: 1,
      target: expectedTarget,
      code: "source-unavailable",
    };
    for (const rejected of [
      { ...input, origin: "https://other.test", message: failure },
      { ...input, sourceMatches: false, message: failure },
      { ...input, message: { ...failure, version: 2 } },
      ...["registrationId", "environmentId", "threadId"].map((key) => ({
        ...input,
        message: { ...failure, target: { ...expectedTarget, [key]: "other" } },
      })),
    ]) {
      expect(handshake.onMessage(rejected)).toBe(false);
      expect(state).toBe("ready");
    }
    vi.advanceTimersByTime(1000);
    expect(state).toBe("ready");
    expect(handshake.onMessage({ ...input, message: failure })).toBe(true);
    expect(state).toBe("source-unavailable");
    expect(handshake.onMessage(input)).toBe(false);
    handshake.onFrameLoad(() => {});
    expect(handshake.onMessage(input)).toBe(true);
    expect(state).toBe("ready");
    handshake.cancel();
    expect(handshake.onMessage({ ...input, message: failure })).toBe(false);
    expect(state).toBe("ready");
  });

  it("surfaces a valid native error for the selected target", () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const handshake = createFrameHandshake({
      expectedOrigin: "https://factory.test",
      expectedTarget,
      timeoutMs: 1000,
      onReady,
      onError,
    });
    const errorMessage = Schema.decodeUnknownSync(FactoryFrameMessage)({
      _tag: "error",
      version: 1,
      target: expectedTarget,
      code: "source-authentication",
    });

    expect(
      handshake.onMessage({
        origin: "https://factory.test",
        sourceMatches: true,
        message: errorMessage,
      }),
    ).toBe(true);
    expect(onError).toHaveBeenCalledWith("source-authentication");
    expect(onReady).not.toHaveBeenCalled();
    handshake.cancel();
  });
});
