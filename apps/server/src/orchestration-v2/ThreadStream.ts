import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
  OrchestrationV2ReplayResetReason,
} from "@t3tools/contracts";

import { buildBoundedThreadProjection } from "./threadHistoryPaging.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

/** Maximum number of reducer applications allowed during a thread resume. */
export const THREAD_RESUME_MAX_REPLAY_EVENTS = 128;

/** Maximum encoded event JSON allowed during a thread resume. */
export const THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES = 1_048_576;

/**
 * Maximum aggregate persisted payload JSON decoded for one thread resume.
 * Keep the original preflight budget: decoded objects and temporary strings
 * cost more than their stored JSON, even if wire projection shrinks them later.
 */
export const THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES = 1_048_576;

export const FACTORY_REPLAY_MAX_EVENTS = 10_000;
export const FACTORY_REPLAY_PAGE_EVENTS = 128;
export const FACTORY_REPLAY_PAGE_RAW_BYTES = 1_048_576;
export const FACTORY_REPLAY_PAGE_ENCODED_BYTES = 1_048_576;

/** Resource-safety check applied before persisted replay payloads are decoded. */
export function isThreadReplayRawPayloadSafe(rawPayloadBytes: number): boolean {
  return rawPayloadBytes <= THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES;
}

/** Encoded payload cost after events have been projected for the wire. */
export function threadReplayEncodedBytes(items: ReadonlyArray<unknown>): number {
  let total = 0;
  for (const item of items) {
    const encoded = JSON.stringify(item);
    total += Buffer.byteLength(encoded ?? "", "utf8");
  }
  return total;
}

export type FactoryReplayPagePlan<A> =
  | { readonly mode: "pages"; readonly pages: ReadonlyArray<ReadonlyArray<A>> }
  | { readonly mode: "snapshot"; readonly reason: "oversized-event" };

/** Split already-projected items so every outbound page respects both limits. */
export function chunkFactoryReplayPage<A>(
  items: ReadonlyArray<A>,
  limits: { readonly maxEvents?: number; readonly maxEncodedBytes?: number } = {},
): FactoryReplayPagePlan<A> {
  const maxEvents = limits.maxEvents ?? FACTORY_REPLAY_PAGE_EVENTS;
  const maxEncodedBytes = limits.maxEncodedBytes ?? FACTORY_REPLAY_PAGE_ENCODED_BYTES;
  const pages: Array<ReadonlyArray<A>> = [];
  let page: Array<A> = [];
  let pageBytes = 0;
  for (const item of items) {
    const encodedBytes = Buffer.byteLength(JSON.stringify(item) ?? "", "utf8");
    if (encodedBytes > maxEncodedBytes) {
      return { mode: "snapshot", reason: "oversized-event" };
    }
    if (
      page.length > 0 &&
      (page.length >= maxEvents || pageBytes + encodedBytes > maxEncodedBytes)
    ) {
      pages.push(page);
      page = [];
      pageBytes = 0;
    }
    page.push(item);
    pageBytes += encodedBytes;
  }
  if (page.length > 0) pages.push(page);
  return { mode: "pages", pages };
}

type ThreadSnapshotStreamItem = Extract<
  OrchestrationV2ThreadStreamItem,
  { readonly kind: "snapshot" }
>;

/** Build the same bounded, wire-projected snapshot for every socket fallback path. */
export function buildBoundedThreadStreamSnapshot(input: {
  readonly snapshotSequence: number;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly resetReason?: OrchestrationV2ReplayResetReason;
}): ThreadSnapshotStreamItem {
  const bounded = buildBoundedThreadProjection({
    snapshotSequence: input.snapshotSequence,
    projection: projectThreadProjectionForWire(input.projection),
  });
  return {
    kind: "snapshot",
    snapshotSequence: input.snapshotSequence,
    projection: bounded.projection,
    historyCursor: bounded.historyCursor,
    hasMoreHistory: bounded.hasMoreHistory,
    latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
    payloadBudgetExceeded: bounded.payloadBudgetExceeded,
    ...(input.resetReason === undefined ? {} : { resetReason: input.resetReason }),
  };
}

export type FactoryReplayPlan =
  | { readonly mode: "replay"; readonly pageEvents: number }
  | { readonly mode: "snapshot"; readonly reason: OrchestrationV2ReplayResetReason };

/** Choose negotiated replay bounds without changing the legacy resume policy. */
export function decideFactoryReplay(input: {
  readonly negotiated: boolean;
  readonly afterSequence: number;
  readonly highWater: number;
  readonly eventCount: number;
  readonly largestRawEventBytes: number;
  readonly largestEncodedEventBytes: number;
  readonly replayEncodedBytes?: number;
}): FactoryReplayPlan {
  if (input.afterSequence > input.highWater) {
    return { mode: "snapshot", reason: "invalid-cursor" };
  }
  if (
    input.eventCount >
    (input.negotiated ? FACTORY_REPLAY_MAX_EVENTS : THREAD_RESUME_MAX_REPLAY_EVENTS)
  ) {
    return { mode: "snapshot", reason: "event-limit" };
  }
  if (
    input.largestRawEventBytes > FACTORY_REPLAY_PAGE_RAW_BYTES ||
    input.largestEncodedEventBytes > FACTORY_REPLAY_PAGE_ENCODED_BYTES ||
    (!input.negotiated &&
      (input.largestRawEventBytes > THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES ||
        (input.replayEncodedBytes ?? 0) > THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES))
  ) {
    return { mode: "snapshot", reason: "oversized-event" };
  }
  return { mode: "replay", pageEvents: FACTORY_REPLAY_PAGE_EVENTS };
}

export type ThreadResumePlan =
  | {
      readonly mode: "replay";
      readonly afterSequence: number;
      readonly throughSequence: number;
    }
  | { readonly mode: "snapshot" };

/**
 * Decide whether a thread subscription should replay the event gap after the
 * client's cursor or send a fresh snapshot instead.
 *
 * A client cursor above the high water mark is stale or invalid. Event count
 * limits reducer churn while encoded bytes limit a small number of large
 * updates. Either excess is cheaper to replace with one current snapshot.
 */
export function decideThreadResume(input: {
  readonly afterSequence: number;
  readonly highWater: number;
  readonly replayEventCount: number;
  readonly replayEncodedBytes: number;
}): ThreadResumePlan {
  if (
    input.afterSequence > input.highWater ||
    input.replayEventCount > THREAD_RESUME_MAX_REPLAY_EVENTS ||
    input.replayEncodedBytes > THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES
  ) {
    return { mode: "snapshot" };
  }
  return {
    mode: "replay",
    afterSequence: input.afterSequence,
    throughSequence: input.highWater,
  };
}
