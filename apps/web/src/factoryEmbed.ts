import {
  FactoryFrameInitMessage,
  FactoryFrameMessage,
  FactoryFrameTarget as FactoryFrameTargetSchema,
  type FactoryFrameTarget,
  type FactoryFrameErrorCode,
  type FactoryFrameMessage as FactoryFrameMessageType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { takeFactoryFrameMessages } from "./factoryFrameCapture";

export { isFactoryEmbedRequested } from "./factoryFrameCapture";

const isFrameInit = Schema.is(FactoryFrameInitMessage);
const isFrameMessage = Schema.is(FactoryFrameMessage);
const isFrameTarget = Schema.is(FactoryFrameTargetSchema);

export interface FactoryEmbedRoute {
  readonly target: FactoryFrameTarget;
}

export class FactoryEmbedError extends Error {
  readonly _tag = "FactoryEmbedError";
  constructor(readonly code: FactoryFrameErrorCode) {
    super(code);
    this.name = this._tag;
  }
}

export function isFactoryEmbedEndpoint(input: {
  readonly origin: string;
  readonly endpoint: string;
}): boolean {
  try {
    const origin = new URL(input.origin);
    const endpoint = new URL(input.endpoint, origin);
    if (
      (origin.protocol !== "https:" && origin.protocol !== "http:") ||
      origin.origin !== input.origin ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      return false;
    const expectedProtocol = origin.protocol === "https:" ? "wss:" : "ws:";
    return (
      endpoint.protocol === expectedProtocol &&
      endpoint.host === origin.host &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash &&
      /^\/factory\/env\/[^/]+\/ws$/.test(endpoint.pathname)
    );
  } catch {
    return false;
  }
}

export function parseFactoryEmbedRoute(href: string): FactoryEmbedRoute | null {
  try {
    const url = new URL(href);
    const flags = url.searchParams.getAll("factoryEmbedded");
    const registrations = url.searchParams.getAll("factoryRegistrationId");
    if (
      flags.length !== 1 ||
      flags[0] !== "1" ||
      registrations.length !== 1 ||
      url.searchParams.size !== 2 ||
      url.hash
    )
      return null;
    const segments = url.pathname.split("/");
    if (segments.length !== 3 || segments[0] !== "" || !segments[1] || !segments[2]) return null;
    const target = {
      environmentId: decodeURIComponent(segments[1]),
      threadId: decodeURIComponent(segments[2]),
      registrationId: registrations[0],
    };
    if (!isFrameTarget(target)) return null;
    return { target };
  } catch {
    return null;
  }
}

export function validateFactoryFrameInit(input: {
  readonly data: unknown;
  readonly origin: string;
  readonly source: MessageEventSource | null;
  readonly parent: MessageEventSource;
  readonly expectedOrigin: string;
  readonly routeTarget: FactoryFrameTarget;
}): typeof FactoryFrameInitMessage.Type | null {
  if (input.source !== input.parent || input.origin !== input.expectedOrigin) return null;
  if (!isFrameInit(input.data)) return null;
  const target = input.data.target;
  if (
    target.registrationId !== input.routeTarget.registrationId ||
    target.environmentId !== input.routeTarget.environmentId ||
    target.threadId !== input.routeTarget.threadId
  )
    return null;
  return input.data;
}

/** `earlyMessages` replays parent messages captured before the app chunk loaded. */
export function waitForFactoryFrameInit(
  routeTarget: FactoryFrameTarget,
  host: Window = window,
  timeoutMs = 10_000,
  earlyMessages: readonly MessageEvent<unknown>[] = takeFactoryFrameMessages(),
): Promise<typeof FactoryFrameInitMessage.Type> {
  if (host.parent === host) return Promise.reject(new FactoryEmbedError("invalid-parent"));
  return new Promise((resolve, reject) => {
    const timeout = host.setTimeout(() => {
      cleanup();
      reject(new FactoryEmbedError("timeout"));
    }, timeoutMs);
    const cleanup = () => {
      host.clearTimeout(timeout);
      host.removeEventListener("message", onMessage);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== host.parent) return;
      if (event.origin !== host.location.origin) {
        cleanup();
        reject(new FactoryEmbedError("invalid-parent"));
        return;
      }
      if (!isFrameInit(event.data)) {
        cleanup();
        reject(new FactoryEmbedError("invalid-message"));
        return;
      }
      const target = event.data.target;
      if (
        target.registrationId !== routeTarget.registrationId ||
        target.environmentId !== routeTarget.environmentId ||
        target.threadId !== routeTarget.threadId
      ) {
        cleanup();
        reject(new FactoryEmbedError("target-mismatch"));
        return;
      }
      cleanup();
      resolve(event.data);
    };
    host.addEventListener("message", onMessage);
    for (const event of earlyMessages) onMessage(event);
  });
}

interface ActiveFactoryEmbed {
  readonly target: FactoryFrameTarget;
  readonly post: (message: FactoryFrameMessageType) => void;
  readonly onMessage?: (message: FactoryFrameMessageType) => void;
}

let activeFactoryEmbed: ActiveFactoryEmbed | null = null;
const factoryEmbedTargetListeners = new Set<(target: FactoryFrameTarget | null) => void>();

function notifyFactoryEmbedTarget(target: FactoryFrameTarget | null): void {
  for (const listener of factoryEmbedTargetListeners) listener(target);
}

export function activateFactoryEmbed(
  target: FactoryFrameTarget,
  onMessage?: (message: FactoryFrameMessageType) => void,
): () => void {
  const active: ActiveFactoryEmbed = {
    target,
    ...(onMessage === undefined ? {} : { onMessage }),
    post: (message) => {
      if (window.parent !== window && isFrameMessage(message)) {
        window.parent.postMessage(message, window.location.origin);
        active.onMessage?.(message);
      }
    },
  };
  activeFactoryEmbed = active;
  notifyFactoryEmbedTarget(target);
  return () => {
    if (activeFactoryEmbed === active) {
      activeFactoryEmbed = null;
      notifyFactoryEmbedTarget(null);
    }
  };
}

export function currentFactoryEmbedTarget(): FactoryFrameTarget | null {
  return activeFactoryEmbed?.target ?? null;
}

export function subscribeFactoryEmbedTarget(
  listener: (target: FactoryFrameTarget | null) => void,
): () => void {
  factoryEmbedTargetListeners.add(listener);
  listener(currentFactoryEmbedTarget());
  return () => {
    factoryEmbedTargetListeners.delete(listener);
  };
}

export function postFactoryEmbedError(
  target: FactoryFrameTarget,
  code: FactoryFrameErrorCode,
): void {
  const message = { _tag: "error" as const, version: 1 as const, target, code };
  if (window.parent !== window && isFrameMessage(message))
    window.parent.postMessage(message, window.location.origin);
}

export function resolveFactoryEmbedHandshakeMessage(input: {
  readonly expectedTarget: FactoryFrameTarget;
  readonly activeTarget: FactoryFrameTarget | null;
  readonly routeTarget: Pick<FactoryFrameTarget, "environmentId" | "threadId"> | null;
  readonly connectionPhase: "connecting" | "connected" | "disconnected" | "blocked";
  readonly threadState: "pending" | "ready" | "missing";
  readonly failureCode?: FactoryFrameErrorCode;
  readonly alreadyReady?: boolean;
}): FactoryFrameMessageType | null {
  const error = (code: FactoryFrameErrorCode): FactoryFrameMessageType => ({
    _tag: "error",
    version: 1,
    target: input.expectedTarget,
    code,
  });
  if (input.activeTarget === null) return null;
  if (
    !sameFactoryFrameTarget(input.activeTarget, input.expectedTarget) ||
    input.routeTarget === null ||
    input.routeTarget.environmentId !== input.expectedTarget.environmentId ||
    input.routeTarget.threadId !== input.expectedTarget.threadId
  )
    return error("target-mismatch");
  if (input.failureCode !== undefined) return error(input.failureCode);
  if (input.threadState === "missing") return error("thread-unavailable");
  if (input.connectionPhase === "connected" && input.threadState === "ready")
    return { _tag: "ready", version: 1, target: input.expectedTarget };
  if (input.alreadyReady && input.connectionPhase !== "connected")
    return error("source-unavailable");
  return null;
}

export function reportFactoryEmbedReady(target: FactoryFrameTarget): boolean {
  const active = activeFactoryEmbed;
  if (!sameFactoryFrameTarget(active?.target ?? null, target) || active === null) return false;
  active.post({ _tag: "ready", version: 1, target });
  return true;
}

export function reportFactoryEmbedError(
  target: FactoryFrameTarget,
  code: FactoryFrameErrorCode,
): boolean {
  if (!sameFactoryFrameTarget(activeFactoryEmbed?.target ?? null, target)) return false;
  activeFactoryEmbed!.post({ _tag: "error", version: 1, target, code });
  return true;
}

export function sameFactoryFrameTarget(
  left: FactoryFrameTarget | null,
  right: FactoryFrameTarget | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.registrationId === right.registrationId &&
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId
  );
}
