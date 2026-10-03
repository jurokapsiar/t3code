import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type ApplicationStoredEvent,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ReplayResetReason,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationEventStoreError } from "../persistence/Errors.ts";
import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { createFactoryReplayStream, threadReplayEncodedBytes } from "./ThreadStream.ts";
import { toShellApplicationEvent, type ShellApplicationEvent } from "./ShellStream.ts";
import { projectDomainEventForWire } from "./WireProjection.ts";

const TestLayer = OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const layer = it.layer(TestLayer);
const now = DateTime.makeUnsafe("2026-10-03T00:00:00.000Z");
const providerInstanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project-factory-replay");

function createdEvent(threadId: ThreadId, index: number): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`factory-replay-${index}`),
    type: "thread.created",
    threadId,
    providerInstanceId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: `Thread ${index}`,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
}

type ReplayTestItem =
  | ShellApplicationEvent
  | { readonly kind: "replay"; readonly sequence: number }
  | { readonly kind: "snapshot-reset"; readonly reason: string }
  | { readonly kind: "synchronized" }
  | { readonly kind: "live"; readonly sequence: number };

layer("factory replay persistence", (it) => {
  it.effect("replays negotiated SQL totals in bounded pages and resets at 10,001 events", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const payload =
        '{"projectId":"factory-replay-project","title":"Replay project",' +
        '"workspaceRoot":"/tmp/factory-replay-project","defaultModelSelection":null,' +
        '"scripts":[],"createdAt":"2026-10-03T00:00:00.000Z",' +
        '"updatedAt":"2026-10-03T00:00:00.000Z"}';
      const payloadBytes = Buffer.byteLength(payload);
      const synchronized: ReplayTestItem = { kind: "synchronized" };
      yield* sql`
        WITH RECURSIVE event_rows(n) AS (
          VALUES (1)
          UNION ALL
          SELECT n + 1 FROM event_rows WHERE n < 10001
        )
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        )
        SELECT
          'factory-exact-replay-' || n, 'project', 'factory-replay-project', n,
          'project.created', '2026-10-03T00:00:00.000Z', 'server', ${payload}, '{}', 2
        FROM event_rows
      `;
      const highWater = yield* store.latestApplicationSequence;
      const measuredPages: Array<{ count: number; rawBytes: number }> = [];
      const measuredEncodedPages: number[] = [];

      for (const eventCount of [0, 128, 129, 1_000, 10_000, 10_001]) {
        const afterSequence = highWater - eventCount;
        const pageCountBeforeReplay = measuredPages.length;
        const readPage = (cursor: number, throughSequence: number) =>
          store
            .readApplicationReplayPage({
              afterSequence: cursor,
              throughSequence,
              maxEvents: 128,
              maxRawPayloadBytes: 1_048_576,
            })
            .pipe(
              Effect.tap((page) =>
                Effect.sync(() =>
                  measuredPages.push({
                    count: page.events.length,
                    rawBytes: page.events.length * payloadBytes,
                  }),
                ),
              ),
            );
        const project = (events: ReadonlyArray<ApplicationStoredEvent>) => {
          const projected = events.map(toShellApplicationEvent);
          measuredEncodedPages.push(threadReplayEncodedBytes(projected));
          return Effect.succeed<ReadonlyArray<ReplayTestItem>>(projected);
        };
        const reset = (reason: OrchestrationV2ReplayResetReason) => {
          const resetItems: ReadonlyArray<ReplayTestItem> = [
            { kind: "snapshot-reset", reason },
            synchronized,
          ];
          return Effect.succeed(Stream.fromIterable(resetItems));
        };
        const completionMarker = Stream.make(synchronized);
        const replay = yield* createFactoryReplayStream({
          afterSequence,
          highWater,
          getStats: () =>
            store.getReplayStats({
              afterSequence,
              throughSequence: highWater,
              maxEvents: 10_000,
            }),
          readPage,
          project,
          reset,
          completionMarker,
          live: Stream.empty,
        });
        const items = Array.from(yield* replay.pipe(Stream.runCollect));

        if (eventCount <= 10_000) {
          const replayed = items.filter(
            (item): item is Extract<ShellApplicationEvent, { readonly sequence: number }> =>
              "sequence" in item && !("kind" in item),
          );
          assert.equal(replayed.length, eventCount);
          assert.deepEqual(
            replayed.map((item) => item.sequence),
            Array.from({ length: eventCount }, (_, index) => afterSequence + index + 1),
          );
          assert.deepEqual(items.at(-1), synchronized);
        } else {
          assert.equal(measuredPages.length, pageCountBeforeReplay);
          assert.deepEqual(items, [
            { kind: "snapshot-reset", reason: "event-limit" },
            { kind: "synchronized" },
          ]);
        }
      }

      assert.equal(measuredPages.length, 91);
      assert.equal(measuredPages.filter((page) => page.count === 128).length, 87);
      for (const page of measuredPages) {
        assert.isAtMost(page.count, 128);
        assert.isAtMost(page.rawBytes, 1_048_576);
      }
      assert.equal(measuredEncodedPages.length, measuredPages.length);
      for (const pageBytes of measuredEncodedPages) assert.isAtMost(pageBytes, 1_048_576);
    }),
  );

  it.effect("orders a publication during replay after synchronization", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* OrchestrationEventStore.OrchestrationEventStore;
        const baseline = yield* store.latestApplicationSequence;
        const projectId = ProjectId.make("factory-replay-boundary");
        const synchronized: ReplayTestItem = { kind: "synchronized" };
        const first = yield* store.appendProjectEvent({
          type: "project.created",
          eventId: EventId.make("factory-replay-boundary-initial"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-10-03T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId,
            title: "Replay boundary",
            workspaceRoot: "/tmp/factory-replay-boundary",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-03T00:00:00.000Z",
            updatedAt: "2026-10-03T00:00:00.000Z",
          },
        });
        const pageStarted = yield* Deferred.make<void>();
        const releasePage = yield* Deferred.make<void>();
        const replay = yield* createFactoryReplayStream<
          ApplicationStoredEvent,
          ReplayTestItem,
          OrchestrationEventStoreError,
          never
        >({
          afterSequence: baseline,
          highWater: first.sequence,
          getStats: () =>
            store.getReplayStats({ afterSequence: baseline, throughSequence: first.sequence }),
          readPage: (cursor, throughSequence) =>
            Deferred.succeed(pageStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releasePage)),
              Effect.andThen(
                store.readApplicationReplayPage({
                  afterSequence: cursor,
                  throughSequence,
                  maxEvents: 128,
                  maxRawPayloadBytes: 1_048_576,
                }),
              ),
            ),
          project: (events) =>
            Effect.succeed<ReadonlyArray<ReplayTestItem>>(
              events.map((event) => ({ kind: "replay", sequence: event.sequence })),
            ),
          reset: (reason) => {
            const resetItems: ReadonlyArray<ReplayTestItem> = [{ kind: "snapshot-reset", reason }];
            return Effect.succeed(Stream.fromIterable(resetItems));
          },
          completionMarker: Stream.make(synchronized),
          live: store
            .streamProjectedApplicationEvents({
              afterSequence: first.sequence,
              project: (event) => event,
            })
            .pipe(
              Stream.take(1),
              Stream.map((event): ReplayTestItem => ({ kind: "live", sequence: event.sequence })),
            ),
        });
        const fiber = yield* replay.pipe(Stream.runCollect, Effect.forkScoped);
        yield* Deferred.await(pageStarted);
        const published = yield* store.appendProjectEvent({
          type: "project.meta-updated",
          eventId: EventId.make("factory-replay-boundary-live"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-10-03T00:00:01.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId,
            title: "Replay boundary updated",
            workspaceRoot: "/tmp/factory-replay-boundary",
            defaultModelSelection: null,
            scripts: [],
            updatedAt: "2026-10-03T00:00:01.000Z",
          },
        });
        yield* store.publishCommitted([published]);
        yield* Deferred.succeed(releasePage, undefined);
        const items = Array.from(yield* Fiber.join(fiber));
        assert.deepEqual(items, [
          { kind: "replay", sequence: first.sequence },
          synchronized,
          { kind: "live", sequence: published.sequence },
        ]);
      }),
    ),
  );
  it.effect("reads at most 128 events and resumes over filtered sequence gaps", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const target = ThreadId.make("factory-replay-target");
      const other = ThreadId.make("factory-replay-other");
      const events = Array.from({ length: 260 }, (_, index) =>
        createdEvent(index % 2 === 0 ? target : other, index),
      );
      yield* store.appendAgentEvents({ events });
      const throughSequence = yield* store.latestAgentSequence();
      const stats = yield* store.getAgentReplayStats({
        threadId: target,
        afterSequence: 0,
        throughSequence,
        maxEvents: 127,
      });
      const first = yield* store.readAgentReplayPage({
        threadId: target,
        afterSequence: 0,
        throughSequence,
        maxEvents: 128,
        maxRawPayloadBytes: stats.rawPayloadBytes,
      });
      assert.equal(first.events.length, 128);
      assert.isTrue(first.hasMore);
      assert.isFalse(first.oversized);
      assert.isTrue(first.events[1]!.sequence - first.events[0]!.sequence > 1);

      const belowRawBoundary = yield* store.readAgentReplayPage({
        threadId: target,
        afterSequence: 0,
        throughSequence,
        maxEvents: 128,
        maxRawPayloadBytes: stats.rawPayloadBytes - 1,
      });
      assert.equal(belowRawBoundary.events.length, 127);
      assert.isTrue(belowRawBoundary.hasMore);

      const shellPage = yield* store.readApplicationReplayPage({
        afterSequence: 0,
        throughSequence,
        maxEvents: 128,
        maxRawPayloadBytes: 1_048_576,
      });
      assert.equal(shellPage.events.length, 128);
      assert.isTrue(shellPage.hasMore);

      const lastSequence = first.events.at(-1)!.sequence;
      const second = yield* store.readAgentReplayPage({
        threadId: target,
        afterSequence: lastSequence,
        throughSequence,
        maxEvents: 128,
        maxRawPayloadBytes: 1_048_576,
      });
      assert.equal(second.events.length, 2);
      assert.isFalse(second.hasMore);
    }),
  );

  it.effect("accepts an exact 1 MiB valid raw event and projects it within the wire page", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const threadId = ThreadId.make("factory-replay-exact-raw");
      const afterSequence = yield* store.latestAgentSequence(threadId);
      const item = {
        id: TurnItemId.make("factory-replay-exact-raw-item"),
        type: "dynamic_tool",
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: "Large but projectable output",
        toolName: "mcp__test__large_result",
        input: { query: "small" },
        output: "x",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      } satisfies OrchestrationV2TurnItem;
      const probe: OrchestrationV2DomainEvent = {
        id: EventId.make("factory-replay-exact-probe"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: item,
      };
      const [probeStored] = yield* store.appendAgentEvents({ events: [probe] });
      const probeStats = yield* store.getAgentReplayStats({
        threadId,
        afterSequence,
        throughSequence: probeStored!.sequence,
        maxEvents: 10_000,
      });
      const outputBytes = 1 + 1_048_576 - probeStats.rawPayloadBytes;
      const [stored] = yield* store.appendAgentEvents({
        events: [
          {
            ...probe,
            id: EventId.make("factory-replay-exact-event"),
            payload: { ...item, output: "x".repeat(outputBytes) },
          },
        ],
      });
      const highWater = stored!.sequence;
      const stats = yield* store.getAgentReplayStats({
        threadId,
        afterSequence: probeStored!.sequence,
        throughSequence: highWater,
        maxEvents: 10_000,
      });
      assert.equal(stats.rawPayloadBytes, 1_048_576);

      const page = yield* store.readAgentReplayPage({
        threadId,
        afterSequence: probeStored!.sequence,
        throughSequence: highWater,
        maxEvents: 128,
        maxRawPayloadBytes: 1_048_576,
      });
      assert.equal(page.events.length, 1);
      assert.isFalse(page.oversized);
      assert.isFalse(page.decodeFailed);

      let encodedPageBytes = 0;
      type Output =
        | {
            readonly kind: "event";
            readonly sequence: number;
            readonly event: OrchestrationV2DomainEvent;
          }
        | { readonly kind: "reset"; readonly reason: string }
        | { readonly kind: "synchronized" };
      const marker: Output = { kind: "synchronized" };
      const replay = yield* createFactoryReplayStream<
        OrchestrationV2StoredEvent,
        Output,
        OrchestrationEventStoreError,
        never
      >({
        afterSequence: probeStored!.sequence,
        highWater,
        getStats: () =>
          store.getAgentReplayStats({
            threadId,
            afterSequence: probeStored!.sequence,
            throughSequence: highWater,
            maxEvents: 10_000,
          }),
        readPage: (cursor, throughSequence) =>
          store.readAgentReplayPage({
            threadId,
            afterSequence: cursor,
            throughSequence,
            maxEvents: 128,
            maxRawPayloadBytes: 1_048_576,
          }),
        project: (events) => {
          const projected = events.map((row) => ({
            kind: "event" as const,
            sequence: row.sequence,
            event: projectDomainEventForWire(row.event),
          }));
          encodedPageBytes = threadReplayEncodedBytes(projected);
          return Effect.succeed(projected);
        },
        reset: (reason) => {
          const resetItems: ReadonlyArray<Output> = [{ kind: "reset", reason }];
          return Effect.succeed(Stream.fromIterable(resetItems));
        },
        completionMarker: Stream.make(marker),
        live: Stream.empty,
      });
      const output = Array.from(yield* replay.pipe(Stream.runCollect));
      assert.isAtMost(encodedPageBytes, 1_048_576);
      assert.equal(output.length, 2);
      assert.equal(output[0]?.kind, "event");
      if (output[0]?.kind !== "event") return assert.fail("Expected a projected event");
      assert.equal(output[0].sequence, highWater);
      assert.deepEqual(output.at(-1), marker);

      const encodedThreadId = ThreadId.make("factory-replay-encoded-limit");
      const encodedAfterSequence = yield* store.latestAgentSequence(encodedThreadId);
      const encodedProbe: OrchestrationV2DomainEvent = {
        ...probe,
        id: EventId.make("factory-replay-encoded-probe"),
        threadId: encodedThreadId,
        payload: {
          ...item,
          id: TurnItemId.make("factory-replay-encoded-item"),
          threadId: encodedThreadId,
          title: "x",
          output: "small",
        },
      };
      const [encodedProbeStored] = yield* store.appendAgentEvents({ events: [encodedProbe] });
      const encodedProbeStats = yield* store.getAgentReplayStats({
        threadId: encodedThreadId,
        afterSequence: encodedAfterSequence,
        throughSequence: encodedProbeStored!.sequence,
        maxEvents: 10_000,
      });
      const titleBytes = 1 + 1_048_576 - encodedProbeStats.rawPayloadBytes;
      const [encodedStored] = yield* store.appendAgentEvents({
        events: [
          {
            ...encodedProbe,
            id: EventId.make("factory-replay-encoded-event"),
            payload: { ...encodedProbe.payload, title: "x".repeat(titleBytes) },
          },
        ],
      });
      const encodedHighWater = encodedStored!.sequence;
      const encodedStats = yield* store.getAgentReplayStats({
        threadId: encodedThreadId,
        afterSequence: encodedProbeStored!.sequence,
        throughSequence: encodedHighWater,
        maxEvents: 10_000,
      });
      assert.equal(encodedStats.rawPayloadBytes, 1_048_576);
      const encodedRawPage = yield* store.readAgentReplayPage({
        threadId: encodedThreadId,
        afterSequence: encodedProbeStored!.sequence,
        throughSequence: encodedHighWater,
        maxEvents: 128,
        maxRawPayloadBytes: 1_048_576,
      });
      assert.equal(encodedRawPage.events.length, 1);
      assert.isFalse(encodedRawPage.oversized);
      let encodedResetReason: string | undefined;
      const encodedReplay = yield* createFactoryReplayStream<
        OrchestrationV2StoredEvent,
        Output,
        OrchestrationEventStoreError,
        never
      >({
        afterSequence: encodedProbeStored!.sequence,
        highWater: encodedHighWater,
        getStats: () =>
          store.getAgentReplayStats({
            threadId: encodedThreadId,
            afterSequence: encodedProbeStored!.sequence,
            throughSequence: encodedHighWater,
            maxEvents: 10_000,
          }),
        readPage: (cursor, throughSequence) =>
          store.readAgentReplayPage({
            threadId: encodedThreadId,
            afterSequence: cursor,
            throughSequence,
            maxEvents: 128,
            maxRawPayloadBytes: 1_048_576,
          }),
        project: (events) => {
          const projected = events.map((row) => ({
            kind: "event" as const,
            sequence: row.sequence,
            event: projectDomainEventForWire(row.event),
          }));
          encodedPageBytes = threadReplayEncodedBytes(projected);
          return Effect.succeed(projected);
        },
        reset: (reason) => {
          encodedResetReason = reason;
          const resetItems: ReadonlyArray<Output> = [{ kind: "reset", reason }, marker];
          return Effect.succeed(Stream.fromIterable(resetItems));
        },
        completionMarker: Stream.make(marker),
        live: Stream.empty,
      });
      const encodedOutput = Array.from(yield* encodedReplay.pipe(Stream.runCollect));
      assert.isAbove(encodedPageBytes, 1_048_576);
      assert.equal(encodedResetReason, "oversized-event");
      assert.deepEqual(encodedOutput, [{ kind: "reset", reason: "oversized-event" }, marker]);
    }),
  );

  it.effect("rejects oversized raw data before event decoding", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("factory-replay-oversized");
      const throughSequence = yield* store.latestAgentSequence();
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          'factory-replay-oversized', 'thread', ${threadId}, 1, 'thread.created',
          '2026-10-03T00:00:00.000Z', 'server', ${"x".repeat(1_048_577)}, '{}', 2
        )
      `;
      const current = yield* store.latestAgentSequence(threadId);
      const page = yield* store.readAgentReplayPage({
        threadId,
        afterSequence: throughSequence,
        throughSequence: current,
        maxEvents: 128,
        maxRawPayloadBytes: 1_048_576,
      });
      assert.deepEqual(page, {
        events: [],
        hasMore: true,
        oversized: true,
        decodeFailed: false,
      });
    }),
  );

  it.effect("uses a reset result when a bounded raw event cannot be decoded", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("factory-replay-decode-failure");
      const afterSequence = yield* store.latestAgentSequence();
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          'factory-replay-decode-failure', 'thread', ${threadId}, 1, 'thread.created',
          '2026-10-03T00:00:00.000Z', 'server', '{}', '{}', 2
        )
      `;
      const throughSequence = yield* store.latestAgentSequence(threadId);
      const threadPage = yield* store.readAgentReplayPage({
        threadId,
        afterSequence,
        throughSequence,
        maxEvents: 128,
        maxRawPayloadBytes: 1_048_576,
      });
      const shellPage = yield* store.readApplicationReplayPage({
        afterSequence,
        throughSequence,
        maxEvents: 128,
        maxRawPayloadBytes: 1_048_576,
      });

      assert.deepEqual(threadPage, {
        events: [],
        hasMore: true,
        oversized: false,
        decodeFailed: true,
      });
      assert.deepEqual(shellPage, {
        events: [],
        hasMore: true,
        oversized: false,
        decodeFailed: true,
      });
    }),
  );
});
