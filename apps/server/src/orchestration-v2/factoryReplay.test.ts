import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

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

layer("factory replay persistence", (it) => {
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
