import * as Schema from "effect/Schema";

import { IsoDateTime, MessageId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const OpenCodeSessionSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("new") }),
  Schema.Struct({ type: Schema.Literal("existing"), sessionId: TrimmedNonEmptyString }),
]);
export type OpenCodeSessionSource = typeof OpenCodeSessionSource.Type;

export const OpenCodeSessionListEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  directory: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastPromptAt: Schema.optional(IsoDateTime),
  model: Schema.optional(TrimmedNonEmptyString),
  agent: Schema.optional(TrimmedNonEmptyString),
});
export type OpenCodeSessionListEntry = typeof OpenCodeSessionListEntry.Type;

export const OpenCodeSessionHistoryMessage = Schema.Struct({
  messageId: MessageId,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type OpenCodeSessionHistoryMessage = typeof OpenCodeSessionHistoryMessage.Type;

export const OpenCodeReconcileResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("reconciled"),
    messages: Schema.Array(OpenCodeSessionHistoryMessage),
  }),
  Schema.Struct({
    status: Schema.Literal("deferred"),
  }),
]);
export type OpenCodeReconcileResult = typeof OpenCodeReconcileResult.Type;
