import * as NodeURL from "node:url";

import type {
  ChatAttachment,
  OpenCodeSessionHistoryMessage,
  ProviderApprovalDecision,
  RuntimeMode,
} from "@t3tools/contracts";
import {
  createOpencodeClient,
  type Agent,
  type FilePartInput,
  type Model,
  type OpencodeClient,
  type PermissionRuleset,
  type ProviderListResponse,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";
import type { OpenCodeSessionListEntry } from "@t3tools/contracts";
import type { UsageRecord } from "../usage/usageTranscripts.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

export const MINIMUM_OPENCODE_VERSION = "1.14.19";
const OPENCODE_HEALTH_TIMEOUT = "5 seconds";

const OpenCodeHealthSchema = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
});
const decodeOpenCodeHealth = Schema.decodeUnknownEffect(OpenCodeHealthSchema);

export function resolveOpenCodeConfigContent(
  inputEnvironment: Readonly<Record<string, string | undefined>> | undefined,
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return inputEnvironment?.OPENCODE_CONFIG_CONTENT ?? inheritedEnvironment.OPENCODE_CONFIG_CONTENT;
}

/** @internal Reads the Azure credential OpenCode stores for custom OpenAI-compatible providers. */
export function parseOpenCodeAuthApiKey(content: string): string | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    return undefined;
  }
  const azure = (decoded as { readonly azure?: unknown }).azure;
  if (azure === null || typeof azure !== "object" || azure === undefined || Array.isArray(azure)) {
    return undefined;
  }
  const credential = azure as {
    readonly type?: unknown;
    readonly apiKey?: unknown;
    readonly key?: unknown;
  };
  if (credential.type !== "api") return undefined;
  const apiKey = credential.apiKey ?? credential.key;
  return typeof apiKey === "string" && apiKey.trim().length > 0 ? apiKey : undefined;
}

export function resolveOpenCodeServerPassword(
  input: {
    readonly external: boolean;
    readonly serverPassword?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (input.serverPassword !== undefined) {
    return input.serverPassword;
  }
  if (input.external) {
    return undefined;
  }
  return input.environment === undefined
    ? inheritedEnvironment.OPENCODE_SERVER_PASSWORD
    : input.environment.OPENCODE_SERVER_PASSWORD;
}

const OPENCODE_SERVER_READY_PREFIX = "opencode server listening";
const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 30_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS = 64 * 1024;
const OPENCODE_SKILL_DISCOVERY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const OPENCODE_SESSION_LIST_LIMIT = 100;
export interface OpenCodeServerProcess {
  readonly url: string;
  readonly serverPassword?: string;
  readonly version: string;
  readonly isRunning: Effect.Effect<boolean>;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly serverPassword?: string;
  readonly version: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
}

const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";
export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeRuntimeError =>
    P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (OpenCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (cause && typeof cause === "object") {
    // SDK v2 throws { response, request, error? } shapes — extract what's useful
    const anyCause = cause as Record<string, unknown>;
    const status = (anyCause.response as { status?: number } | undefined)?.status;
    const body = anyCause.error ?? anyCause.data ?? anyCause.body;
    const encodedBody = encodeJsonStringForDiagnostics(body ?? cause);
    if (encodedBody) {
      return `status=${status ?? "?"} body=${encodedBody}`;
    }
  }
  return String(cause);
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

export const verifyOpenCodeServerVersion = Effect.fn("verifyOpenCodeServerVersion")(function* (
  client: OpencodeClient,
) {
  const healthOption = yield* runOpenCodeSdk("global.health", (signal) =>
    client.global.health({ signal }),
  ).pipe(Effect.timeoutOption(OPENCODE_HEALTH_TIMEOUT));
  if (Option.isNone(healthOption)) {
    return yield* new OpenCodeRuntimeError({
      operation: "global.health",
      detail: "Timed out while checking the OpenCode server version.",
    });
  }

  const health = yield* decodeOpenCodeHealth(healthOption.value.data).pipe(
    Effect.mapError(
      (cause) =>
        new OpenCodeRuntimeError({
          operation: "global.health",
          detail: `OpenCode server returned an invalid health response. T3 Code requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
          cause,
        }),
    ),
  );
  if (parseSemver(health.version) === null) {
    return yield* new OpenCodeRuntimeError({
      operation: "global.health",
      detail: `OpenCode server returned an invalid version. T3 Code requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
    });
  }
  if (compareSemverVersions(health.version, MINIMUM_OPENCODE_VERSION) < 0) {
    return yield* new OpenCodeRuntimeError({
      operation: "global.health",
      detail: `OpenCode v${health.version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`,
    });
  }
  return health.version;
});

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly providerList: ProviderListResponse;
  readonly agents: ReadonlyArray<Agent>;
  readonly skills: ReadonlyArray<OpenCodeSkill>;
}

interface OpenCodeCliSessionRecord {
  readonly id: unknown;
  readonly title: unknown;
  readonly directory: unknown;
  readonly created: unknown;
  readonly updated: unknown;
}

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface OpenCodeSkill {
  readonly name?: string | null;
  readonly description?: string | null;
  readonly location?: string | null;
}

const OpenCodeSkillSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  location: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeOpenCodeSkillsCliOutputExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Array(OpenCodeSkillSchema)),
);

export interface OpenCodeRuntimeShape {
  /**
   * Spawns a local OpenCode server process. Its lifetime is bound to the caller's
   * `Scope.Scope` — the child is killed automatically when that scope closes.
   * Consumers that want a long-lived server must create and hold a scope explicitly
   * (see {@link Scope.make}) and close it when done.
   */
  readonly startOpenCodeServerProcess: (input: {
    readonly binaryPath: string;
    readonly directory: string;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
  /**
   * Returns a handle to either an externally-managed OpenCode server (when
   * `serverUrl` is provided — no lifetime is attached to the caller's scope) or a
   * freshly spawned local server whose lifetime is bound to the caller's scope.
   */
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly directory: string;
    readonly serverUrl?: string | null;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly maxOutputBytes?: number;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly directory: string;
    readonly serverPassword?: string;
  }) => OpencodeClient;
  readonly loadOpenCodeInventory: (
    client: OpencodeClient,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
  readonly loadOpenCodeSkills: (
    client: OpencodeClient,
  ) => Effect.Effect<ReadonlyArray<OpenCodeSkill>, OpenCodeRuntimeError>;
  readonly loadOpenCodeSessions?: (input: {
    readonly client: OpencodeClient;
    readonly directory: string;
  }) => Effect.Effect<ReadonlyArray<OpenCodeSessionListEntry>, OpenCodeRuntimeError>;
  readonly loadOpenCodeSessionMessages?: (input: {
    readonly client: OpencodeClient;
    readonly directory: string;
    readonly sessionId: string;
  }) => Effect.Effect<ReadonlyArray<OpenCodeSessionHistoryMessage>, OpenCodeRuntimeError>;
  readonly loadInventoryFromCli: (input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
  readonly loadSkillsFromCli: (input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<ReadonlyArray<OpenCodeSkill>, OpenCodeRuntimeError>;
  readonly listOpenCodeSessions?: (input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<ReadonlyArray<OpenCodeSessionListEntry>, OpenCodeRuntimeError>;
  readonly listAllOpenCodeSessions?: (input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<ReadonlyArray<OpenCodeSessionListEntry>, OpenCodeRuntimeError>;
  /** Exports one session for on-demand usage reconciliation. */
  readonly exportOpenCodeSession?: (input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly sessionId: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<ReadonlyArray<UsageRecord>, OpenCodeRuntimeError>;
}

function parseServerUrlFromOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(OPENCODE_SERVER_READY_PREFIX)) {
      continue;
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    return match?.[1] ?? null;
  }
  return null;
}

const SLUG_LINE_RE = /^(\S+\/\S+)\s*$/;
const AGENT_HEADER_RE = /^(.+)\s+\((\S+)\)\s*$/;

// Agents that are always hidden in OpenCode but the CLI "agent list" command
// does not expose the hidden flag. Keep in sync with OpenCode agent
// definitions (in the OpenCode repo: packages/opencode/src/agent/agent.ts).
const KNOWN_HIDDEN_AGENTS = new Set(["compaction", "summary", "title"]);

/** @internal */
export function parseModelsCliOutput(stdout: string): {
  readonly providers: ReadonlyMap<
    string,
    { readonly id: string; readonly name: string; readonly models: { [key: string]: Model } }
  >;
  readonly connected: ReadonlyArray<string>;
} {
  const providers = new Map<
    string,
    { id: string; name: string; models: { [key: string]: Model } }
  >();
  const lines = stdout.split("\n");
  let currentSlug: string | null = null;
  const jsonLines: Array<string> = [];

  const flushModel = () => {
    if (currentSlug !== null && jsonLines.length > 0) {
      const jsonStr = jsonLines.join("\n").trim();
      if (jsonStr.length > 0) {
        try {
          const model = JSON.parse(jsonStr) as Model;
          const separator = currentSlug.indexOf("/");
          if (separator > 0) {
            const providerID = currentSlug.slice(0, separator);
            const modelID = currentSlug.slice(separator + 1);
            let provider = providers.get(providerID);
            if (!provider) {
              provider = { id: providerID, name: providerID, models: {} };
              providers.set(providerID, provider);
            }
            provider.models[modelID] = model;
          }
        } catch {
          // Skip unparseable model JSON
        }
      }
    }
    currentSlug = null;
    jsonLines.length = 0;
  };

  for (const line of lines) {
    // A model's JSON body is a single `JSON.stringify` line starting with `{`,
    // while a provider/model slug is a bare `provider/model` header. Only the
    // latter can be a slug: without this guard a body line with no interior
    // whitespace and a `/` in one of its values (e.g. an OpenRouter model whose
    // `id` is `vendor/model`) matches SLUG_LINE_RE, so flushModel runs against
    // an empty body and the model is silently dropped.
    const slugMatch = line.trimStart().startsWith("{") ? null : SLUG_LINE_RE.exec(line);
    if (slugMatch) {
      flushModel();
      currentSlug = slugMatch[1]!;
    } else if (currentSlug !== null) {
      jsonLines.push(line);
    }
  }
  flushModel();

  return { providers, connected: [...providers.keys()] };
}

/** @internal */
export function parseAgentListCliOutput(stdout: string): ReadonlyArray<Agent> {
  const agents: Array<Agent> = [];
  const lines = stdout.split("\n");
  let currentHeader: { name: string; mode: string } | null = null;
  const blockLines: Array<string> = [];

  const flushAgent = () => {
    if (currentHeader !== null) {
      const jsonStr = blockLines.join("\n").trim();
      if (jsonStr.length > 0) {
        try {
          const permission = JSON.parse(jsonStr);
          agents.push({
            name: currentHeader.name,
            mode: currentHeader.mode as Agent["mode"],
            hidden: KNOWN_HIDDEN_AGENTS.has(currentHeader.name),
            permission,
            options: {},
          });
        } catch {
          // Skip unparseable agent
        }
      }
    }
    currentHeader = null;
    blockLines.length = 0;
  };

  for (const line of lines) {
    const match = AGENT_HEADER_RE.exec(line);
    if (match) {
      flushAgent();
      currentHeader = { name: match[1]!, mode: match[2]! };
    } else if (currentHeader !== null) {
      blockLines.push(line);
    }
  }
  flushAgent();

  return agents;
}

/** @internal */
export function parseSkillsCliOutput(stdout: string): ReadonlyArray<OpenCodeSkill> {
  const result = decodeOpenCodeSkillsCliOutputExit(stdout);
  return Exit.isSuccess(result) ? result.value : [];
}

function parseOpenCodeTimestamp(value: unknown): string | undefined {
  const timestamp =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number.isNaN(Number(value))
          ? Date.parse(value)
          : Number(value)
        : Number.NaN;
  if (!Number.isFinite(timestamp)) return undefined;
  const iso = DateTime.formatIso(DateTime.makeUnsafe(timestamp));
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

function quotePosixShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteWindowsShell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** @internal Returns the latest prompt time from an OpenCode message payload. */
export function latestOpenCodeUserPromptAt(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  return messages.reduce<string | undefined>((latest, value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return latest;
    const info = (value as { readonly info?: unknown }).info;
    if (info === null || typeof info !== "object" || info === undefined || Array.isArray(info)) {
      return latest;
    }
    const candidate = info as {
      readonly role?: unknown;
      readonly time?: { readonly created?: unknown };
    };
    if (candidate.role !== "user") return latest;
    const createdAt = parseOpenCodeTimestamp(candidate.time?.created);
    if (createdAt === undefined) return latest;
    return latest === undefined || createdAt > latest ? createdAt : latest;
  }, undefined);
}

/** @internal Parses the telemetry fields emitted by `opencode export`. */
export function parseOpenCodeExport(
  content: string,
  sessionId: string,
): ReadonlyArray<UsageRecord> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    return [];
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return [];
  const messages = (decoded as { readonly messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  const positiveInt = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  return messages.flatMap((value): Array<UsageRecord> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
    const info = (value as { readonly info?: unknown }).info;
    if (info === null || typeof info !== "object" || info === undefined || Array.isArray(info))
      return [];
    const record = info as {
      readonly id?: unknown;
      readonly role?: unknown;
      readonly providerID?: unknown;
      readonly modelID?: unknown;
      readonly model?: unknown;
      readonly time?: { readonly created?: unknown; readonly completed?: unknown };
      readonly tokens?: unknown;
      readonly cost?: unknown;
    };
    if (record.role !== "assistant" || typeof record.id !== "string") return [];
    const timestamp = parseOpenCodeTimestamp(record.time?.completed ?? record.time?.created);
    if (timestamp === undefined || record.tokens === null || typeof record.tokens !== "object")
      return [];
    const tokenRecord = record.tokens as {
      readonly input?: unknown;
      readonly output?: unknown;
      readonly reasoning?: unknown;
      readonly cache?: { readonly read?: unknown; readonly write?: unknown };
    };
    const provider = typeof record.providerID === "string" ? record.providerID.trim() : "";
    const modelId = typeof record.modelID === "string" ? record.modelID.trim() : "";
    const fallbackModel = typeof record.model === "string" ? record.model.trim() : "";
    const model = provider && modelId ? `${provider}/${modelId}` : fallbackModel;
    if (!model) return [];
    const cachedInputTokens = positiveInt(tokenRecord.cache?.read);
    const cacheCreationTokens = positiveInt(tokenRecord.cache?.write);
    const inputTokens = positiveInt(tokenRecord.input);
    const outputTokens = positiveInt(tokenRecord.output);
    const timestampMs = Date.parse(timestamp);
    return [
      {
        provider: "opencode",
        timestampMs,
        model,
        sessionId,
        totals: {
          uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
          cachedInputTokens,
          cacheCreationTokens,
          outputTokens,
          reasoningTokens: Math.min(outputTokens, positiveInt(tokenRecord.reasoning)),
        },
        reportedCostUsd:
          typeof record.cost === "number" && Number.isFinite(record.cost) && record.cost >= 0
            ? record.cost
            : null,
        dedupeKey: `opencode:${sessionId}:${record.id}`,
      },
    ];
  });
}

/** @internal */
export function parseOpenCodeSessionListCliOutput(
  stdout: string,
): ReadonlyArray<OpenCodeSessionListEntry> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded)) return [];

  const sessions: Array<OpenCodeSessionListEntry> = [];
  for (const value of decoded) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as OpenCodeCliSessionRecord;
    if (
      typeof record.id !== "string" ||
      typeof record.directory !== "string" ||
      typeof record.title !== "string"
    ) {
      continue;
    }
    const createdAt = parseOpenCodeTimestamp(record.created);
    const updatedAt = parseOpenCodeTimestamp(record.updated);
    const id = record.id.trim();
    const directory = record.directory.trim();
    if (!createdAt || !updatedAt || id.length === 0 || directory.length === 0) continue;
    const title = record.title.trim();
    sessions.push({
      id,
      directory,
      createdAt,
      updatedAt,
      ...(title.length > 0 ? { title } : {}),
    });
  }
  return sessions;
}

/** @internal */
export function parseOpenCodeSessionMessages(
  messages: unknown,
  sessionId: string,
  fallbackCreatedAt: string,
): ReadonlyArray<OpenCodeSessionHistoryMessage> {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((value): Array<OpenCodeSessionHistoryMessage> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as {
      readonly info?: {
        readonly id?: unknown;
        readonly role?: unknown;
        readonly time?: { readonly created?: unknown };
      };
      readonly parts?: unknown;
    };
    if (
      !record.info ||
      typeof record.info.id !== "string" ||
      (record.info.role !== "user" && record.info.role !== "assistant") ||
      !Array.isArray(record.parts)
    ) {
      return [];
    }
    const text = record.parts
      .flatMap((part) => {
        if (part === null || typeof part !== "object" || Array.isArray(part)) return [];
        const candidate = part as { readonly type?: unknown; readonly text?: unknown };
        return candidate.type === "text" && typeof candidate.text === "string"
          ? [candidate.text]
          : [];
      })
      .join("");
    if (text.trim().length === 0) return [];
    return [
      {
        messageId:
          `opencode:history:${sessionId}:${record.info.id}` as OpenCodeSessionHistoryMessage["messageId"],
        role: record.info.role,
        text,
        createdAt: parseOpenCodeTimestamp(record.info.time?.created) ?? fallbackCreatedAt,
      },
    ];
  });
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

/**
 * Attachments OpenCode can hand to a model as a native file part. Anything
 * else (ZIP, binaries, image formats like BMP/AVIF/SVG that model APIs
 * reject, or files over the direct-attachment size limit) would make the turn
 * fail before it starts, so those ride only as the file path ProviderService
 * puts in the prompt.
 */
const OPENCODE_NATIVE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const OPENCODE_NATIVE_FILE_PART_MAX_BYTES = 20 * 1024 * 1024;

function isOpenCodeNativeFilePart(input: {
  readonly mimeType: string;
  readonly sizeBytes: number;
}): boolean {
  if (input.sizeBytes > OPENCODE_NATIVE_FILE_PART_MAX_BYTES) {
    return false;
  }
  const normalized = input.mimeType.trim().toLowerCase();
  return (
    OPENCODE_NATIVE_IMAGE_MIMES.has(normalized) ||
    normalized.startsWith("text/") ||
    normalized === "application/pdf"
  );
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];

  for (const attachment of input.attachments ?? []) {
    if (
      attachment.type === "file" &&
      "source" in attachment &&
      attachment.source?._tag === "pasted-text"
    ) {
      continue;
    }
    if (!isOpenCodeNativeFilePart(attachment)) {
      continue;
    }
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }

    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: NodeURL.pathToFileURL(attachmentPath).href,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ];
  }

  // "Auto-accept edits" is documented as "auto-approve edits, ask before other
  // actions", so prompting for every edit ignores the mode the user picked.
  // "auto" is left asking on purpose: the docs say providers without an AI
  // reviewer, OpenCode among them, fall back to Supervised for that mode.
  const editAction = runtimeMode === "auto-accept-edits" ? "allow" : "ask";

  // Session rules override OpenCode's agent defaults. Allow reads and task
  // updates, but keep its default approval rules for environment files.
  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "lsp", pattern: "*", action: "allow" },
    { permission: "skill", pattern: "*", action: "allow" },
    { permission: "todowrite", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: editAction },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
    case "acceptAlways":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") {
      return raw.trim().length > 0 ? [raw] : [];
    }
    return [];
  });
}

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return OpenCodeRuntimeError.is(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

const makeOpenCodeRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService.NetService;
  const hostPlatform = yield* HostProcessPlatform;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolveCommand = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    resolveSpawnCommand(command, args, env ? { env } : {});

  const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveCommand(input.binaryPath, input.args, input.environment);
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          detached: hostPlatform !== "win32",
          shell: spawnCommand.shell,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.environment ? { env: input.environment } : { extendEnv: true }),
        }),
      );
      const terminateCommandGroup =
        hostPlatform === "win32"
          ? child.kill({ killSignal: "SIGKILL" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), "SIGKILL");
              } catch {
                // The command and its process group may already have exited.
              }
            });
      yield* Effect.addFinalizer(() => terminateCommandGroup.pipe(Effect.ignore));
      const collectOptions =
        input.maxOutputBytes === undefined ? undefined : { maxBytes: input.maxOutputBytes };
      const [stdout, stderr] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout, collectOptions),
          collectStreamAsString(child.stderr, collectOptions),
        ],
        { concurrency: "unbounded" },
      );
      const code = yield* child.exitCode;
      const exitCode = Number(code);
      if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new OpenCodeRuntimeError({
          operation: "runOpenCodeCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return {
        stdout,
        stderr,
        code: exitCode,
      } satisfies OpenCodeCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runOpenCodeCommand",
          `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
    createOpencodeClient({
      baseUrl: input.baseUrl,
      directory: input.directory,
      ...(input.serverPassword
        ? {
            headers: {
              Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
            },
          }
        : {}),
      throwOnError: true,
    });

  const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (input) =>
    Effect.gen(function* () {
      // Bind this server's lifetime to the caller's scope. When the caller's
      // scope closes, the spawned child is killed and all associated fibers
      // are interrupted automatically — no `close()` method needed.
      const runtimeScope = yield* Scope.Scope;

      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to find available port: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));
      const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
      const spawnCommand = yield* resolveCommand(input.binaryPath, args, input.environment);
      const serverPassword = resolveOpenCodeServerPassword({
        external: false,
        ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
      });
      const configuredOpenAiKey = input.environment?.OPENAI_API_KEY?.trim();
      const openCodeAuthApiKey =
        configuredOpenAiKey && configuredOpenAiKey.length > 0
          ? undefined
          : yield* Effect.gen(function* () {
              const home = input.environment?.HOME ?? process.env.HOME;
              if (!home) return undefined;
              const authPath = path.join(home, ".local", "share", "opencode", "auth.json");
              const content = yield* fileSystem
                .readFileString(authPath)
                .pipe(Effect.orElseSucceed(() => undefined));
              return content === undefined ? undefined : parseOpenCodeAuthApiKey(content);
            });

      const configContent = resolveOpenCodeConfigContent(input.environment);
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            detached: hostPlatform !== "win32",
            shell: spawnCommand.shell,
            cwd: input.directory,
            env: {
              ...input.environment,
              ...(openCodeAuthApiKey !== undefined ? { OPENAI_API_KEY: openCodeAuthApiKey } : {}),
              ...(serverPassword !== undefined ? { OPENCODE_SERVER_PASSWORD: serverPassword } : {}),
              // Respect an OPENCODE_CONFIG_CONTENT provided by the caller or
              // inherited process environment. When neither is set, omit the
              // override so OpenCode can load its normal config files. The
              // value is set explicitly when present because `extendEnv` is
              // false whenever `input.environment` is provided.
              ...(configContent !== undefined ? { OPENCODE_CONFIG_CONTENT: configContent } : {}),
            },
            extendEnv: input.environment === undefined,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );

      const killOpenCodeProcessGroup = (signal: NodeJS.Signals) =>
        hostPlatform === "win32"
          ? child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), signal);
              } catch {
                // The direct child may already have exited after starting the
                // server; the process group kill is best-effort cleanup for
                // any serve process left in that group.
              }
            });
      const terminateChild = killOpenCodeProcessGroup("SIGTERM").pipe(
        Effect.andThen(Effect.sleep("1 second")),
        Effect.andThen(killOpenCodeProcessGroup("SIGKILL")),
        Effect.ignore,
      );
      yield* Scope.addFinalizer(runtimeScope, terminateChild);

      const stdoutRef = yield* Ref.make<string | null>("");
      const stderrRef = yield* Ref.make<string | null>("");
      const readyDeferred = yield* Deferred.make<string, OpenCodeRuntimeError>();

      const setReadyFromStdoutChunk = (chunk: string) =>
        Ref.modify(stdoutRef, (stdout) => {
          if (stdout === null) {
            return [null, null] as const;
          }
          const nextStdout = `${stdout}${chunk}`;
          return [
            parseServerUrlFromOutput(nextStdout),
            nextStdout.slice(-OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS),
          ] as const;
        }).pipe(
          Effect.flatMap((parsed) =>
            parsed ? Deferred.succeed(readyDeferred, parsed).pipe(Effect.ignore) : Effect.void,
          ),
        );

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(setReadyFromStdoutChunk),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.update(stderrRef, (stderr) =>
            stderr === null
              ? null
              : `${stderr}${chunk}`.slice(-OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS),
          ),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const stdout = (yield* Ref.get(stdoutRef)) ?? "";
            const stderr = (yield* Ref.get(stderrRef)) ?? "";
            const exitCode = Number(code);
            yield* Deferred.fail(
              readyDeferred,
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: [
                  `OpenCode server exited before startup completed (code: ${String(exitCode)}).`,
                  stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
                  stderr.trim() ? `stderr:\n${stderr.trim()}` : null,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                cause: { exitCode, stdout, stderr },
              }),
            ).pipe(Effect.ignore);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const readyExit = yield* Effect.exit(
        Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
      );

      if (Exit.isFailure(readyExit) || Option.isNone(readyExit.value)) {
        yield* Fiber.interruptAll([stdoutFiber, stderrFiber, exitFiber]).pipe(Effect.ignore);
      }

      if (Exit.isFailure(readyExit)) {
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureRuntimeError(
          "startOpenCodeServerProcess",
          `Failed while waiting for OpenCode server startup: ${openCodeRuntimeErrorDetail(squashed)}`,
          squashed,
        );
      }

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: `Timed out waiting for OpenCode server start after ${timeoutMs}ms.`,
        });
      }

      // Keep draining both pipes until the process scope closes. Stopping the
      // readers can block OpenCode when its output buffers fill. Startup output
      // is no longer needed, so discard later output instead of retaining it.
      yield* Ref.set(stdoutRef, null);
      yield* Ref.set(stderrRef, null);

      const url = readyOption.value;
      const version = yield* verifyOpenCodeServerVersion(
        createOpenCodeSdkClient({
          baseUrl: url,
          directory: input.directory,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
        }),
      );

      return {
        url,
        ...(serverPassword !== undefined ? { serverPassword } : {}),
        version,
        isRunning: child.isRunning.pipe(Effect.orElseSucceed(() => false)),
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      } satisfies OpenCodeServerProcess;
    });

  const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      const serverPassword = resolveOpenCodeServerPassword({
        external: true,
        ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      });
      return verifyOpenCodeServerVersion(
        createOpenCodeSdkClient({
          baseUrl: serverUrl,
          directory: input.directory,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
        }),
      ).pipe(
        Effect.map((version) => ({
          url: serverUrl,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
          version,
          exitCode: null,
          external: true,
        })),
      );
    }

    return startOpenCodeServerProcess({
      binaryPath: input.binaryPath,
      directory: input.directory,
      ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }).pipe(
      Effect.map((server) => ({
        url: server.url,
        ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        version: server.version,
        exitCode: server.exitCode,
        external: false,
      })),
    );
  };

  const loadProviders = (client: OpencodeClient) =>
    runOpenCodeSdk("provider.list", (signal) => client.provider.list(undefined, { signal })).pipe(
      Effect.filterMapOrFail(
        (list) =>
          list.data
            ? Result.succeed(list.data)
            : Result.fail(
                new OpenCodeRuntimeError({
                  operation: "provider.list",
                  detail: "OpenCode provider list was empty.",
                }),
              ),
        (result) => result,
      ),
    );

  const loadAgents = (client: OpencodeClient) =>
    runOpenCodeSdk("app.agents", (signal) => client.app.agents(undefined, { signal })).pipe(
      Effect.map((result) => result.data ?? []),
      Effect.orElseSucceed((): ReadonlyArray<Agent> => []),
    );

  const loadOpenCodeSkills: OpenCodeRuntimeShape["loadOpenCodeSkills"] = (client) =>
    runOpenCodeSdk("app.skills", (signal) => client.app.skills(undefined, { signal })).pipe(
      Effect.map((result) =>
        (result.data ?? []).map((skill) => ({
          name: skill.name,
          ...(skill.description === undefined ? {} : { description: skill.description }),
          location: skill.location,
        })),
      ),
    );

  const loadOpenCodeSessions: OpenCodeRuntimeShape["loadOpenCodeSessions"] = (input) =>
    runOpenCodeSdk("session.list", (signal) =>
      input.client.session.list({ roots: true, limit: OPENCODE_SESSION_LIST_LIMIT }, { signal }),
    )
      .pipe(
        Effect.map((response) =>
          (response.data ?? []).flatMap((session): Array<OpenCodeSessionListEntry> => {
            const time = session.time;
            const createdAt = parseOpenCodeTimestamp(time?.created);
            const updatedAt = parseOpenCodeTimestamp(time?.updated);
            const directory = session.directory?.trim();
            const id = session.id?.trim();
            if (!createdAt || !updatedAt || !directory || !id) return [];
            const title = session.title?.trim();
            return [
              {
                id,
                directory,
                createdAt,
                updatedAt,
                ...(title ? { title } : {}),
              } satisfies OpenCodeSessionListEntry,
            ];
          }),
        ),
      )
      .pipe(
        Effect.flatMap((sessions) => {
          const canonicalize = (directory: string) =>
            fileSystem
              .realPath(directory)
              .pipe(Effect.orElseSucceed(() => path.resolve(directory)));
          return Effect.gen(function* () {
            const requestedDirectory = yield* canonicalize(input.directory);
            const matching = yield* Effect.forEach(
              sessions,
              (session) =>
                canonicalize(session.directory).pipe(
                  Effect.map((directory) =>
                    directory === requestedDirectory ? session : undefined,
                  ),
                ),
              { concurrency: 1 },
            );
            const matchingSessions = matching
              .filter((session): session is OpenCodeSessionListEntry => session !== undefined)
              .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
              .slice(0, OPENCODE_SESSION_LIST_LIMIT);
            return yield* Effect.forEach(
              matchingSessions,
              (session) =>
                runOpenCodeSdk("session.messages", (signal) =>
                  input.client.session.messages({ sessionID: session.id }, { signal }),
                ).pipe(
                  Effect.map((response) => {
                    const lastPromptAt = latestOpenCodeUserPromptAt(response.data);
                    return lastPromptAt ? { ...session, lastPromptAt } : session;
                  }),
                  Effect.orElseSucceed(() => session),
                ),
              { concurrency: 4 },
            );
          });
        }),
      );
  const loadOpenCodeSessionMessages: OpenCodeRuntimeShape["loadOpenCodeSessionMessages"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const session = yield* runOpenCodeSdk("session.get", (signal) =>
        input.client.session.get({ sessionID: input.sessionId }, { signal }),
      );
      const sessionDirectory = session.data?.directory?.trim();
      if (sessionDirectory !== undefined) {
        const canonicalize = (directory: string) =>
          fileSystem.realPath(directory).pipe(Effect.orElseSucceed(() => path.resolve(directory)));
        const [requestedDirectory, actualDirectory] = yield* Effect.all([
          canonicalize(input.directory),
          canonicalize(sessionDirectory),
        ]);
        if (requestedDirectory !== actualDirectory) {
          return yield* new OpenCodeRuntimeError({
            operation: "session.messages",
            detail: `OpenCode session '${input.sessionId}' belongs to a different directory.`,
          });
        }
      }
      const response = yield* runOpenCodeSdk("session.messages", (signal) =>
        input.client.session.messages({ sessionID: input.sessionId }, { signal }),
      );
      return parseOpenCodeSessionMessages(
        response.data,
        input.sessionId,
        DateTime.formatIso(yield* DateTime.now),
      );
    });
  const loadSkills = (client: OpencodeClient) =>
    loadOpenCodeSkills(client).pipe(Effect.orElseSucceed((): ReadonlyArray<OpenCodeSkill> => []));

  const loadOpenCodeInventory: OpenCodeRuntimeShape["loadOpenCodeInventory"] = (client) =>
    Effect.all([loadProviders(client), loadAgents(client), loadSkills(client)], {
      concurrency: "unbounded",
    }).pipe(Effect.map(([providerList, agents, skills]) => ({ providerList, agents, skills })));

  const loadInventoryFromCli: OpenCodeRuntimeShape["loadInventoryFromCli"] = (input) =>
    Effect.gen(function* () {
      const env = input.environment !== undefined ? { environment: input.environment } : ({} as {});
      const commandContext = { cwd: input.cwd, ...env };

      const runModelsCli = () =>
        runOpenCodeCommand({
          binaryPath: input.binaryPath,
          args: ["models", "--verbose"],
          ...commandContext,
        }).pipe(Effect.exit);
      const runAgentsCli = () =>
        runOpenCodeCommand({
          binaryPath: input.binaryPath,
          args: ["agent", "list"],
          ...commandContext,
        }).pipe(Effect.exit);
      const runSkillsCli = () =>
        runOpenCodeCommand({
          binaryPath: input.binaryPath,
          args: ["debug", "skill"],
          maxOutputBytes: OPENCODE_SKILL_DISCOVERY_MAX_OUTPUT_BYTES,
          ...commandContext,
        }).pipe(Effect.exit);

      // Every OpenCode CLI command opens the same shared SQLite database. Running them
      // concurrently causes "database is locked" failures, so run them one at a time.
      const [initialModelsResult, initialAgentsResult, initialSkillsResult] = yield* Effect.all(
        [runModelsCli(), runAgentsCli(), runSkillsCli()],
        { concurrency: 1 },
      );
      let modelsResult = initialModelsResult;
      let agentsResult = initialAgentsResult;
      let skillsResult = initialSkillsResult;

      // Retry once after 1s on transient failures (e.g. SQLite "database is locked")
      const needsModelsRetry = modelsResult._tag === "Failure" || modelsResult.value.code !== 0;
      const needsAgentsRetry = agentsResult._tag === "Failure" || agentsResult.value.code !== 0;
      const needsSkillsRetry = skillsResult._tag === "Failure" || skillsResult.value.code !== 0;
      if (needsModelsRetry || needsAgentsRetry || needsSkillsRetry) {
        yield* Effect.sleep("1 second");
        const [m2, a2, s2] = yield* Effect.all(
          [
            needsModelsRetry ? runModelsCli() : Effect.succeed(modelsResult),
            needsAgentsRetry ? runAgentsCli() : Effect.succeed(agentsResult),
            needsSkillsRetry ? runSkillsCli() : Effect.succeed(skillsResult),
          ],
          { concurrency: 1 },
        );
        modelsResult = m2;
        agentsResult = a2;
        skillsResult = s2;
      }

      if (modelsResult._tag === "Failure") {
        const cause = Cause.squash(modelsResult.cause);
        return yield* ensureRuntimeError(
          "loadInventoryFromCli",
          `Failed to load OpenCode models: ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        );
      }
      if (modelsResult.value.code !== 0) {
        return yield* new OpenCodeRuntimeError({
          operation: "loadInventoryFromCli",
          detail: `OpenCode models command exited with code ${modelsResult.value.code}.`,
        });
      }

      const parsed = parseModelsCliOutput(modelsResult.value.stdout);
      const connected = [...parsed.connected];
      const allProviders: ProviderListResponse["all"] = [...parsed.providers.values()].map(
        (provider) => ({
          id: provider.id,
          name: provider.name,
          source: "config" as const,
          env: [],
          options: {},
          models: provider.models,
        }),
      );

      // Agent and skill metadata enrich the provider snapshot but are not required
      // for an authoritative model inventory, so either may degrade to an empty list.
      let agents: ReadonlyArray<Agent> = [];
      if (agentsResult._tag === "Success" && agentsResult.value.code === 0) {
        agents = parseAgentListCliOutput(agentsResult.value.stdout);
      }
      let skills: ReadonlyArray<OpenCodeSkill> = [];
      if (skillsResult._tag === "Success" && skillsResult.value.code === 0) {
        skills = parseSkillsCliOutput(skillsResult.value.stdout);
      }

      return {
        providerList: { all: allProviders, default: {}, connected },
        agents,
        skills,
      };
    });

  const loadSkillsFromCli: OpenCodeRuntimeShape["loadSkillsFromCli"] = (input) =>
    runOpenCodeCommand({
      binaryPath: input.binaryPath,
      args: ["debug", "skill"],
      cwd: input.cwd,
      maxOutputBytes: OPENCODE_SKILL_DISCOVERY_MAX_OUTPUT_BYTES,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
    }).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(parseSkillsCliOutput(result.stdout))
          : Effect.fail(
              new OpenCodeRuntimeError({
                operation: "loadSkillsFromCli",
                detail: `OpenCode skills command exited with code ${result.code}.`,
              }),
            ),
      ),
    );

  const listOpenCodeSessions: OpenCodeRuntimeShape["listOpenCodeSessions"] = (input) =>
    Effect.gen(function* () {
      const result = yield* runOpenCodeCommand({
        binaryPath: input.binaryPath,
        args: ["session", "list", "--max-count=100", "--format=json"],
        cwd: input.cwd,
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
      });
      if (result.code !== 0) {
        return yield* new OpenCodeRuntimeError({
          operation: "session.list",
          detail: `OpenCode session list command exited with code ${result.code}.`,
        });
      }

      const sessions = parseOpenCodeSessionListCliOutput(result.stdout);
      const canonicalize = (directory: string) =>
        fileSystem.realPath(directory).pipe(Effect.orElseSucceed(() => path.resolve(directory)));
      const requestedDirectory = yield* canonicalize(input.cwd);
      const matching = yield* Effect.forEach(
        sessions,
        (session) =>
          canonicalize(session.directory).pipe(
            Effect.map((directory) => (directory === requestedDirectory ? session : null)),
          ),
        { concurrency: 1 },
      );

      return matching
        .filter((session): session is OpenCodeSessionListEntry => session !== null)
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, OPENCODE_SESSION_LIST_LIMIT);
    });

  const exportOpenCodeSession: OpenCodeRuntimeShape["exportOpenCodeSession"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-opencode-export-",
        });
        const outputPath = path.join(temporaryDirectory, "session.json");
        const command =
          hostPlatform === "win32"
            ? {
                binaryPath: input.environment?.ComSpec ?? "cmd.exe",
                args: [
                  "/d",
                  "/s",
                  "/c",
                  `${quoteWindowsShell(input.binaryPath)} export --sanitize ${quoteWindowsShell(input.sessionId)} > ${quoteWindowsShell(outputPath)}`,
                ],
              }
            : {
                binaryPath: "sh",
                args: [
                  "-c",
                  `exec ${quotePosixShell(input.binaryPath)} export --sanitize ${quotePosixShell(input.sessionId)} > ${quotePosixShell(outputPath)}`,
                ],
              };
        const result = yield* runOpenCodeCommand({
          ...command,
          cwd: input.cwd,
          maxOutputBytes: 64 * 1024,
          ...(input.environment !== undefined ? { environment: input.environment } : {}),
        });
        if (result.code !== 0) {
          return yield* new OpenCodeRuntimeError({
            operation: "session.export",
            detail: `OpenCode export command exited with code ${result.code}.`,
          });
        }
        const content = yield* fileSystem.readFileString(outputPath).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "session.export",
                detail: `OpenCode export output could not be read: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );
        return parseOpenCodeExport(content, input.sessionId);
      }),
    );

  const listAllOpenCodeSessions: OpenCodeRuntimeShape["listAllOpenCodeSessions"] = (input) =>
    Effect.gen(function* () {
      const result = yield* runOpenCodeCommand({
        binaryPath: input.binaryPath,
        args: ["session", "list", "--format=json"],
        cwd: input.cwd,
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
      });
      if (result.code !== 0) {
        return yield* new OpenCodeRuntimeError({
          operation: "session.listAll",
          detail: `OpenCode session list command exited with code ${result.code}.`,
        });
      }
      return parseOpenCodeSessionListCliOutput(result.stdout).toSorted((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
    });

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer,
    runOpenCodeCommand,
    createOpenCodeSdkClient,
    loadOpenCodeInventory,
    loadOpenCodeSessions,
    loadOpenCodeSessionMessages,
    loadOpenCodeSkills,
    loadInventoryFromCli,
    loadSkillsFromCli,
    listOpenCodeSessions,
    listAllOpenCodeSessions,
    exportOpenCodeSession,
  } satisfies OpenCodeRuntimeShape;
});

export class OpenCodeRuntime extends Context.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "t3/provider/opencodeRuntime",
) {}

export const OpenCodeRuntimeLive = Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime).pipe(
  Layer.provide(NetService.layer),
);
