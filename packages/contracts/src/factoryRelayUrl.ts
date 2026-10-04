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

/** Ordinary clients keep native URL semantics. Relay callers fail visibly, never fall back to a source. */
export function resolveSourceHttpUrl(
  base: string,
  path: string,
  options?: SourceHttpUrlMode,
): string {
  if (options?.mode !== "factory-relay") {
    try {
      return new URL(path, base).toString();
    } catch {
      throw new SourceHttpUrlError();
    }
  }
  const result = resolveFactoryRelayUrl(base, path);
  if (result === null) throw new SourceHttpUrlError();
  if (options.environmentId === undefined) return result;
  if (!options.environmentId.trim() || controlCharacters.test(options.environmentId))
    throw new SourceHttpUrlError();
  return `${result}${result.includes("?") ? "&" : "?"}environmentId=${encodeURIComponent(options.environmentId)}`;
}
