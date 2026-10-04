import * as Deferred from "effect/Deferred";
import {
  FactoryRemoteTarget,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { factoryRelayHttpRoute, isSafeSourcePath } from "@t3tools/contracts/factoryRelayUrl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Connections from "./Connections.ts";
import * as RelayPolicy from "./RelayPolicy.ts";
import { decodeThreadHistoryCursor } from "../orchestration-v2/threadHistoryPaging.ts";

export const HTTP_RELAY_UPLOAD_LIMIT = PROVIDER_SEND_TURN_MAX_FILE_BYTES;
export const HTTP_RELAY_DETAIL_LIMIT = 8 * 1024 * 1024;
export const HTTP_RELAY_ASSET_LIMIT = 256 * 1024 * 1024;

export class HttpRelayError extends Schema.TaggedError<HttpRelayError>()("HttpRelayError", {
  reason: Schema.Literals([
    "invalid-request",
    "route-forbidden",
    "protocol",
    "redirect",
    "upload-too-large",
    "response-too-large",
    "transport",
  ]),
  status: Schema.Number,
}) {
  override get message() {
    return `The source HTTP relay failed: ${this.reason}.`;
  }
}

const isHttpRelayError = Schema.is(HttpRelayError);

/** The over-limit chunk is never forwarded. Counter state belongs to one stream consumer. */
export const boundRelayBody = <E, R>(
  body: Stream.Stream<Uint8Array, E, R>,
  limit: number,
  direction: "upload" | "response",
) =>
  Stream.suspend(() => {
    let bytes = 0;
    return body.pipe(
      Stream.mapEffect((chunk) => {
        bytes += chunk.byteLength;
        return bytes <= limit
          ? Effect.succeed(chunk)
          : Effect.fail(
              new HttpRelayError({
                reason: direction === "upload" ? "upload-too-large" : "response-too-large",
                status: direction === "upload" ? 413 : 502,
              }),
            );
      }),
    );
  });

export class HttpRelay extends Context.Service<
  HttpRelay,
  {
    readonly forward: (input: {
      readonly target: FactoryRemoteTarget;
      readonly request: HttpServerRequest.HttpServerRequest;
      readonly callerScopes: ReadonlyArray<AuthEnvironmentScope>;
    }) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      HttpRelayError | RelayPolicy.RelayDenied | Connections.SourceFailure,
      Scope.Scope
    >;
  }
>()("t3/factory/HttpRelay") {}

const make = Effect.gen(function* () {
  const policy = yield* RelayPolicy.RelayPolicy;
  const connections = yield* Connections.Connections;
  return HttpRelay.of({
    forward: Effect.fnUntraced(function* ({ target, request, callerScopes }) {
      const prefix = RelayPolicy.relayRoutePrefix(target.registrationId);
      const raw = request.url.startsWith("/")
        ? request.url
        : request.url.replace(/^https?:\/\/[^/]+/, "");
      if (!raw.startsWith(prefix) || !isSafeSourcePath(raw))
        return yield* new HttpRelayError({ reason: "invalid-request", status: 400 });
      const url = new URL(raw, "http://factory.invalid");
      if (
        url.searchParams.getAll("environmentId").length !== 1 ||
        url.searchParams.get("environmentId") !== target.environmentId ||
        request.headers.authorization !== undefined ||
        request.headers.dpop !== undefined
      )
        return yield* new HttpRelayError({ reason: "invalid-request", status: 400 });
      url.searchParams.delete("environmentId");
      const sourcePath = url.pathname.slice(prefix.length - 1) + url.search;
      const route = factoryRelayHttpRoute(sourcePath);
      if (route === null)
        return yield* new HttpRelayError({
          reason:
            url.search || !isSafeSourcePath(sourcePath) ? "invalid-request" : "route-forbidden",
          status: url.search || !isSafeSourcePath(sourcePath) ? 400 : 403,
        });
      const key = `${request.method} ${route}`;
      if (!Object.hasOwn(RelayPolicy.relayHttpPolicy, key))
        return yield* new HttpRelayError({ reason: "route-forbidden", status: 403 });
      if (
        route.startsWith("/api/orchestration/") &&
        request.headers[ORCHESTRATION_PROTOCOL_HEADER] !== ORCHESTRATION_PROTOCOL_VERSION_TEXT
      )
        return yield* new HttpRelayError({ reason: "protocol", status: 426 });
      if (route.endsWith("/history"))
        yield* Effect.try({
          try: () => {
            if (url.searchParams.getAll("cursor").length !== 1) throw new Error("Missing cursor.");
            return decodeThreadHistoryCursor(url.searchParams.get("cursor")!);
          },
          catch: () => new HttpRelayError({ reason: "invalid-request", status: 400 }),
        });
      const access = yield* policy.authorize({ target, method: key, callerScopes });
      const source = yield* connections.openHttp(access);
      const upload = request.method === "POST";
      const responseLimit =
        route === "/api/assets/*" ? HTTP_RELAY_ASSET_LIMIT : HTTP_RELAY_DETAIL_LIMIT;
      const length = request.headers["content-length"];
      if (
        upload &&
        length !== undefined &&
        (!/^\d+$/.test(length) ||
          !Number.isSafeInteger(Number(length)) ||
          Number(length) > HTTP_RELAY_UPLOAD_LIMIT)
      )
        return yield* new HttpRelayError({ reason: "upload-too-large", status: 413 });
      let outgoing = HttpClientRequest.make(request.method)(sourcePath);
      for (const key of [
        ORCHESTRATION_PROTOCOL_HEADER,
        "content-type",
        "content-length",
        "range",
        "if-range",
        "accept",
      ])
        if (request.headers[key] !== undefined)
          outgoing = HttpClientRequest.setHeader(outgoing, key, request.headers[key]);
      let uploadFailure: HttpRelayError | undefined;
      const uploadComplete = yield* Deferred.make<void>();
      if (upload) {
        const bodyPull = yield* Stream.toPull(request.stream);
        const body = boundRelayBody(
          Stream.fromPull(Effect.succeed(bodyPull)),
          HTTP_RELAY_UPLOAD_LIMIT,
          "upload",
        ).pipe(
          Stream.timeoutOrElse({
            duration: "20 seconds",
            orElse: () => Stream.fail(new HttpRelayError({ reason: "transport", status: 504 })),
          }),
          Stream.ensuring(Deferred.succeed(uploadComplete, undefined)),
          Stream.tapError((error) =>
            Effect.sync(() => {
              if (isHttpRelayError(error)) uploadFailure = error;
            }),
          ),
        );
        outgoing = HttpClientRequest.bodyStream(outgoing, body, {
          contentType: request.headers["content-type"] ?? "application/octet-stream",
          contentLength: length === undefined ? undefined : Number(length),
        });
      }
      yield* access.checkCurrent;
      // A source responds after storing an upload. Time active bytes separately from headers.
      const headerDeadline = (upload ? Deferred.await(uploadComplete) : Effect.void).pipe(
        Effect.andThen(Effect.sleep("20 seconds")),
        Effect.andThen(Effect.fail(new HttpRelayError({ reason: "transport", status: 504 }))),
      );
      const response = yield* source.execute(outgoing).pipe(
        Effect.raceFirst(access.closed),
        Effect.raceFirst(headerDeadline),
        Effect.catchTag("SourceFailure", (error) => Effect.fail(uploadFailure ?? error)),
      );
      yield* access.checkCurrent;
      if (response.status >= 300 && response.status < 400)
        return yield* new HttpRelayError({ reason: "redirect", status: 502 });
      const responseLength = response.headers["content-length"];
      if (
        request.method !== "HEAD" &&
        responseLength !== undefined &&
        (!/^\d+$/.test(responseLength) || Number(responseLength) > responseLimit)
      )
        return yield* new HttpRelayError({ reason: "response-too-large", status: 502 });
      const headers: Record<string, string> = {
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      };
      for (const key of [
        "content-type",
        "content-disposition",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
      ])
        if (response.headers[key] !== undefined) headers[key] = response.headers[key];
      if (request.method === "HEAD" || response.status === 204)
        return HttpServerResponse.empty({
          status: response.status,
          headers: {
            ...headers,
            ...(responseLength === undefined ? {} : { "content-length": responseLength }),
          },
        });
      const body = boundRelayBody(response.stream, responseLimit, "response").pipe(
        Stream.mapError((error) =>
          isHttpRelayError(error)
            ? error
            : new HttpRelayError({ reason: "transport", status: 502 }),
        ),
        Stream.merge(Stream.fromEffect(access.closed).pipe(Stream.drain), {
          haltStrategy: "either",
        }),
        Stream.tapError(() => Effect.logWarning("The source HTTP response stream failed.")),
      );
      return HttpServerResponse.stream(body, { status: response.status, headers });
    }),
  });
});
export const layer = Layer.effect(HttpRelay, make);
