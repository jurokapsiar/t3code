import { Schema } from "effect";
import { FactoryFrameInitMessage, FactoryFrameMessage } from "@t3tools/contracts/factory";
import type {
  FactoryFrameErrorCode,
  FactoryFrameInitMessage as FrameInitMessage,
  FactoryFrameTarget,
  FactoryFrameMessage as FrameMessage,
} from "@t3tools/contracts/factory";

export interface FrameMessageInput {
  readonly origin: string;
  readonly expectedOrigin: string;
  readonly sourceMatches: boolean;
  readonly expectedTarget: FactoryFrameTarget;
  readonly message: unknown;
}

export interface FrameHandshakeMessageInput {
  readonly origin: string;
  readonly sourceMatches: boolean;
  readonly message: unknown;
}

export interface FrameHandshakeOptions {
  readonly expectedOrigin: string;
  readonly expectedTarget: FactoryFrameTarget;
  readonly timeoutMs: number;
  readonly onReady: () => void;
  readonly onError: (code: FactoryFrameErrorCode) => void;
}

export interface FrameHandshake {
  onFrameLoad(send: (message: FrameInitMessage, targetOrigin: string) => void): void;
  onMessage(input: FrameHandshakeMessageInput): boolean;
  cancel(): void;
}

function getAcceptedFrameMessage(input: FrameMessageInput): FrameMessage | undefined {
  if (
    input.origin !== input.expectedOrigin ||
    !input.sourceMatches ||
    !Schema.is(FactoryFrameMessage)(input.message)
  )
    return undefined;
  return matchesTarget(input.message.target, input.expectedTarget) ? input.message : undefined;
}

function matchesTarget(left: FactoryFrameTarget, right: FactoryFrameTarget): boolean {
  return (
    left.registrationId === right.registrationId &&
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId
  );
}

export function acceptFrameMessage(input: FrameMessageInput): boolean {
  return getAcceptedFrameMessage(input) !== undefined;
}

export function createFrameHandshake(options: FrameHandshakeOptions): FrameHandshake {
  let phase: "pending" | "ready" | "failed" = "pending";
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armTimeout = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (cancelled || phase !== "pending") return;
      phase = "failed";
      options.onError("timeout");
    }, options.timeoutMs);
  };
  armTimeout();
  const initMessage = Schema.decodeUnknownSync(FactoryFrameInitMessage)({
    _tag: "init",
    version: 1,
    target: options.expectedTarget,
  });

  return {
    onFrameLoad(send) {
      if (cancelled) return;
      phase = "pending";
      armTimeout();
      send(initMessage, options.expectedOrigin);
    },
    onMessage(input) {
      if (cancelled || phase === "failed") return false;
      const message = getAcceptedFrameMessage({
        ...input,
        expectedOrigin: options.expectedOrigin,
        expectedTarget: options.expectedTarget,
      });
      if (message === undefined || (phase === "ready" && message._tag === "ready")) return false;
      phase = message._tag === "ready" ? "ready" : "failed";
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (message._tag === "ready") options.onReady();
      else options.onError(message.code);
      return true;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
