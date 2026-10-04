import * as Schema from "effect/Schema";

import { FactoryRegistrationId } from "./factory.ts";

// eslint-disable-next-line no-control-regex -- URL validation must reject encoded control bytes.
const controlCharacters = /[\u0000-\u001f]/;

export type SourceHttpUrlMode = {
  readonly mode: "factory-relay";
  readonly environmentId?: string;
};

export class SourceHttpUrlError extends Error {
  readonly _tag = "SourceHttpUrlError";
  constructor() {
    super("The source HTTP URL is not allowed.");
    this.name = this._tag;
  }
}

const isFactoryRegistrationId = Schema.is(FactoryRegistrationId);

export function factoryRelayPrefix(registrationId: string): string | null {
  if (!isFactoryRegistrationId(registrationId) || registrationId === "." || registrationId === "..")
    return null;
  return "/factory/env/" + encodeURIComponent(registrationId) + "/";
}

/** Check before URL parsing: URL normalizes dot segments, including encoded dots. */
export function isSafeSourcePath(path: string): boolean {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\\s#]/.test(path) ||
    controlCharacters.test(path)
  )
    return false;
  const pathname = path.split("?", 1)[0]!;
  try {
    return pathname
      .split("/")
      .slice(1)
      .every((segment) => {
        const decoded = decodeURIComponent(segment);
        return (
          decoded !== "" &&
          decoded !== "." &&
          decoded !== ".." &&
          !/[/%\\]/.test(decoded) &&
          !controlCharacters.test(decoded)
        );
      });
  } catch {
    return false;
  }
}

export type FactoryRelayHttpRoute =
  | "/api/projects"
  | "/api/orchestration/threads/:threadId"
  | "/api/orchestration/threads/:threadId/bounded"
  | "/api/orchestration/threads/:threadId/history"
  | "/api/assets/*"
  | "/api/attachments/upload/*";

/** Fixed source inventory, shared by URL resolution and the HTTP transport. */
export function factoryRelayHttpRoute(sourcePath: string): FactoryRelayHttpRoute | null {
  if (!isSafeSourcePath(sourcePath)) return null;
  const url = new URL(sourcePath, "http://source.invalid");
  let route: FactoryRelayHttpRoute | null = null;
  if (url.pathname === "/api/projects") route = "/api/projects";
  else if (/^\/api\/assets\/[^/]+\/.+$/.test(url.pathname)) route = "/api/assets/*";
  else if (/^\/api\/attachments\/upload\/[A-Za-z0-9_.-]+$/.test(url.pathname))
    route = "/api/attachments/upload/*";
  else {
    const match = /^\/api\/orchestration\/threads\/[^/]+(\/bounded|\/history)?$/.exec(url.pathname);
    if (match)
      route =
        match[1] === "/bounded"
          ? "/api/orchestration/threads/:threadId/bounded"
          : match[1] === "/history"
            ? "/api/orchestration/threads/:threadId/history"
            : "/api/orchestration/threads/:threadId";
  }
  if (route === null) return null;
  const keys = [...url.searchParams.keys()];
  if (
    keys.length &&
    (route !== "/api/orchestration/threads/:threadId/history" ||
      keys.length !== 1 ||
      keys[0] !== "cursor" ||
      !url.searchParams.get("cursor"))
  )
    return null;
  return route;
}

export function resolveFactoryRelayUrl(prefix: string, sourcePath: string): string | null {
  if (factoryRelayHttpRoute(sourcePath) === null) return null;
  const relative = prefix.startsWith("/") && !prefix.startsWith("//");
  try {
    const rawPath = relative ? prefix : /^https?:\/\/[^/]+(\/.*)$/.exec(prefix)?.[1];
    if (
      !rawPath ||
      !/^\/factory\/env\/[^/?#]+\/$/.test(rawPath) ||
      !isSafeSourcePath(rawPath.slice(0, -1))
    )
      return null;
    const registration = decodeURIComponent(rawPath.split("/")[3]!);
    if (
      !registration ||
      registration === "." ||
      registration === ".." ||
      /\s/.test(registration) ||
      controlCharacters.test(registration)
    )
      return null;
    const base = new URL(prefix, "http://factory.invalid");
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== rawPath
    )
      return null;
    const resolved = new URL(sourcePath.slice(1), base);
    return relative ? resolved.pathname + resolved.search : resolved.toString();
  } catch {
    return null;
  }
}

/**
 * The embedded connection carries its environment id in an internal, credential-free base URL.
 * Keep the public relay prefix itself query-free and validate this metadata before using it.
 */
function embeddedRelayBase(
  base: string,
): { readonly prefix: string; readonly environmentId: string } | null {
  try {
    const url = new URL(base);
    const ids = url.searchParams.getAll("environmentId");
    const match = /^\/factory\/env\/([^/]+)\/$/.exec(url.pathname);
    if (
      !match ||
      ids.length !== 1 ||
      !ids[0]?.trim() ||
      [...url.searchParams.keys()].some((key) => key !== "environmentId") ||
      url.hash ||
      url.username ||
      url.password ||
      !["http:", "https:"].includes(url.protocol)
    )
      return null;
    const registrationId = decodeURIComponent(match[1]!);
    if (factoryRelayPrefix(registrationId) !== url.pathname) return null;
    url.search = "";
    return { prefix: url.toString(), environmentId: ids[0] };
  } catch {
    return null;
  }
}

/** Ordinary clients keep native URL semantics. Relay callers fail visibly, never fall back to a source. */
export function resolveSourceHttpUrl(
  base: string,
  path: string,
  options?: SourceHttpUrlMode,
): string {
  const inferred = options === undefined ? embeddedRelayBase(base) : null;
  const relay = options?.mode === "factory-relay" ? embeddedRelayBase(base) : inferred;
  if (options?.mode !== "factory-relay" && inferred === null) {
    try {
      return new URL(path, base).toString();
    } catch {
      throw new SourceHttpUrlError();
    }
  }
  const result = resolveFactoryRelayUrl(relay?.prefix ?? base, path);
  if (result === null) throw new SourceHttpUrlError();
  const environmentId = options?.environmentId ?? relay?.environmentId;
  if (environmentId === undefined) return result;
  if (
    !environmentId.trim() ||
    controlCharacters.test(environmentId) ||
    (relay !== null && relay.environmentId !== environmentId)
  )
    throw new SourceHttpUrlError();
  return `${result}${result.includes("?") ? "&" : "?"}environmentId=${encodeURIComponent(environmentId)}`;
}
