// Dependency-free so the entry bootstrap can listen before the app chunk loads.
// Factory posts its init once on iframe load, which does not wait for the
// dynamically imported app, router, or React effects.

export function isFactoryEmbedRequested(href?: string): boolean {
  try {
    const url = new URL(href ?? window.location.href);
    return url.searchParams.has("factoryEmbedded") || url.searchParams.has("factoryRegistrationId");
  } catch {
    return false;
  }
}

export interface FactoryFrameMessageCapture {
  /** Stops capturing and returns the first parent message, if any. Repeatable. */
  readonly take: () => readonly MessageEvent<unknown>[];
}

// The init wait settles on the first parent message (accept or reject), so only
// that one is retained and capture detaches as soon as it arrives.
export function captureFactoryFrameMessages(host: Window): FactoryFrameMessageCapture {
  let first: MessageEvent<unknown> | undefined;
  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== host.parent) return;
    first = event;
    host.removeEventListener("message", onMessage);
  };
  host.addEventListener("message", onMessage);
  return {
    take: () => {
      host.removeEventListener("message", onMessage);
      return first === undefined ? [] : [first];
    },
  };
}

let pageCapture: FactoryFrameMessageCapture | null = null;

/** Called by the entry bootstrap before the app chunk is imported. */
export function startFactoryFrameMessageCapture(host: Window = window): void {
  if (pageCapture !== null || host.parent === host) return;
  if (!isFactoryEmbedRequested(host.location.href)) return;
  pageCapture = captureFactoryFrameMessages(host);
}

export function takeFactoryFrameMessages(): readonly MessageEvent<unknown>[] {
  return pageCapture?.take() ?? [];
}
