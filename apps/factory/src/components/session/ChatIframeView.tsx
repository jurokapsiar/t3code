import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import type { FactoryFrameErrorCode, FactoryFrameTarget } from "@t3tools/contracts/factory";
import { MessageBar } from "../../design-system/forms";
import type { FactoryConnectionApi } from "../../factory/FactoryConnection";
import { factoryKeys, frameTargetKey } from "../../factory/queryKeys";
import { createFrameHandshake } from "../../factory/frameHandshake";
import type { FrameHandshake } from "../../factory/frameHandshake";
import styles from "./ChatIframeView.module.css";

interface ChatIframeViewProps {
  readonly factoryId: string;
  readonly target: FactoryFrameTarget;
  readonly connection: FactoryConnectionApi;
  readonly sourceReady: boolean;
  readonly unavailableReason: string;
}

type FrameState =
  | { readonly phase: "waiting"; readonly identity: string }
  | { readonly phase: "ready"; readonly identity: string }
  | { readonly phase: "error"; readonly identity: string; readonly code: FactoryFrameErrorCode };

const frameErrorCopy: Record<FactoryFrameErrorCode, string> = {
  "invalid-route": "The chat route is invalid. The source was not opened.",
  "invalid-parent": "The source did not accept this Factory window.",
  "invalid-message": "The source sent an invalid chat handshake message.",
  "target-mismatch": "The source returned a different session. The source was not opened.",
  "thread-unavailable": "This session is no longer available at the source.",
  "source-unavailable": "The source is offline. Chat is not available.",
  "source-stale": "Source data is stale. Chat is not available.",
  "source-authentication": "The source rejected authentication. Check the source connection.",
  "source-protocol": "The source uses an incompatible protocol.",
  "connection-failed": "The source connection failed. Chat is not available.",
  timeout: "The source did not confirm this session in time.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function routeErrorMessage(error: unknown): string {
  if (isRecord(error) && error._tag === "EnvironmentAuthorizationError") {
    return "You do not have permission to open chat for this session.";
  }
  const code =
    isRecord(error) && error._tag === "FactoryError" && typeof error.code === "string"
      ? error.code
      : undefined;
  switch (code) {
    case "feature-disabled":
    case "capability-required":
      return "This source does not support embedded chat.";
    case "source-unavailable":
      return "The source is offline. Chat is not available.";
    case "source-stale":
      return "Source data is stale. Chat is not available.";
    case "source-authentication":
      return "The source rejected authentication. Check the source connection.";
    case "source-protocol":
      return "The source uses an incompatible protocol.";
    case "not-found":
    case "target-mismatch":
      return "This session is no longer available at the source.";
    default:
      return "The factory could not open chat for this session.";
  }
}

function routeMatchesTarget(
  route: {
    readonly target: { readonly registrationId: string; readonly environmentId: string };
    readonly threadId: string;
  },
  target: FactoryFrameTarget,
): boolean {
  return (
    route.target.registrationId === target.registrationId &&
    route.target.environmentId === target.environmentId &&
    route.threadId === target.threadId
  );
}

function routeStaysOnFactory(href: string): boolean {
  try {
    const factoryOrigin = window.location.origin;
    return new URL(href, factoryOrigin).origin === factoryOrigin;
  } catch {
    return false;
  }
}

export default function ChatIframeView({
  factoryId,
  target,
  connection,
  sourceReady,
  unavailableReason,
}: ChatIframeViewProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const handshakeRef = useRef<FrameHandshake | undefined>(undefined);
  const [frameState, setFrameState] = useState<FrameState>();
  const routeQuery = useQuery({
    queryKey: factoryKeys.embeddedRoute(factoryId, target),
    queryFn: ({ signal }) =>
      connection.request(
        (client) =>
          client["factory.environments.getEmbeddedRoute"]({
            target: { registrationId: target.registrationId, environmentId: target.environmentId },
            threadId: target.threadId,
          }),
        { signal },
      ),
    enabled: sourceReady,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });

  const routeIsFresh =
    sourceReady &&
    !routeQuery.isError &&
    !routeQuery.isFetching &&
    routeQuery.isFetchedAfterMount &&
    routeQuery.data !== undefined;
  const route = routeIsFresh ? routeQuery.data : undefined;
  const routeMatches = route !== undefined && routeMatchesTarget(route, target);
  const routeHasChat = route?.sourceAccess.capabilities.websocket === true;
  const routeIsSameOrigin = route !== undefined && routeStaysOnFactory(route.href);
  const identity =
    route !== undefined && routeMatches && routeHasChat && routeIsSameOrigin
      ? JSON.stringify([frameTargetKey(target), routeQuery.dataUpdatedAt])
      : undefined;

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null || identity === undefined) return;
    const expectedOrigin = window.location.origin;
    const handshake = createFrameHandshake({
      expectedOrigin,
      expectedTarget: target,
      timeoutMs: 25_000,
      onReady: () => setFrameState({ phase: "ready", identity }),
      onError: (code) => setFrameState({ phase: "error", identity, code }),
    });
    const onMessage = (event: MessageEvent<unknown>) => {
      handshake.onMessage({
        origin: event.origin,
        sourceMatches: event.source === frame.contentWindow,
        message: event.data,
      });
    };
    handshakeRef.current = handshake;
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      handshake.cancel();
      if (handshakeRef.current === handshake) handshakeRef.current = undefined;
    };
  }, [identity, target.environmentId, target.registrationId, target.threadId]);

  if (!sourceReady) {
    return (
      <div className={styles.iframeArea}>
        <MessageBar intent="warning">{unavailableReason}</MessageBar>
      </div>
    );
  }
  if (routeQuery.isError) {
    return (
      <div className={styles.iframeArea}>
        <MessageBar intent="error">{routeErrorMessage(routeQuery.error)}</MessageBar>
      </div>
    );
  }
  if (routeQuery.isFetching || !routeQuery.isFetchedAfterMount || routeQuery.data === undefined) {
    return (
      <div className={styles.iframeArea}>
        <MessageBar intent="info">Requesting an authorised chat route from the factory.</MessageBar>
      </div>
    );
  }
  if (!routeMatches) {
    return (
      <div className={styles.iframeArea}>
        <MessageBar intent="error">
          The factory returned a route for a different session. The source was not opened.
        </MessageBar>
      </div>
    );
  }
  if (!routeHasChat) {
    return (
      <div className={styles.iframeArea}>
        <MessageBar intent="info">This source does not support embedded chat.</MessageBar>
      </div>
    );
  }
  if (!routeIsSameOrigin || identity === undefined) {
    return (
      <div className={styles.iframeArea}>
        <MessageBar intent="error">
          The factory returned a chat route outside this origin. The source was not opened.
        </MessageBar>
      </div>
    );
  }

  const currentFrameState =
    frameState?.identity === identity ? frameState : { phase: "waiting" as const, identity };
  return (
    <div className={styles.iframeArea}>
      <div className={styles.iframeSurface}>
        <iframe
          key={identity}
          ref={frameRef}
          className={styles.iframe}
          data-ready={currentFrameState.phase === "ready"}
          title="Session chat"
          src={route.href}
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerPolicy="no-referrer"
          onLoad={() => {
            const contentWindow = frameRef.current?.contentWindow;
            if (contentWindow === null || contentWindow === undefined) return;
            setFrameState({ phase: "waiting", identity });
            handshakeRef.current?.onFrameLoad((message, targetOrigin) => {
              contentWindow.postMessage(message, targetOrigin);
            });
          }}
        />
        {currentFrameState.phase === "ready" ? null : (
          <div className={styles.frameStatus} role="status" aria-live="polite">
            {currentFrameState.phase === "error" ? (
              <MessageBar intent="error">{frameErrorCopy[currentFrameState.code]}</MessageBar>
            ) : (
              <MessageBar intent="info">Connecting to the selected session.</MessageBar>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
