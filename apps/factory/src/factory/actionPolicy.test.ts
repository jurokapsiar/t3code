import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { SourceSessionOwner, type SourceRpcClient } from "./sourceSessions";
import { FactoryEnvironmentView } from "@t3tools/contracts/factory";
import * as Schema from "effect/Schema";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import type { BoundedSnapshot } from "./sourceDetailApi";
import {
  canControlSource,
  SourceActionRegistry,
  sourceActionScopeKey,
  dispatchSourceCommand,
  createCommandId,
  createThreadId,
  isRollbackCompleted,
  isSourceActionCompleted,
  sourceActionResultText,
  rollbackUnavailableReason,
  sourceActionRecordText,
} from "./actionPolicy";

const synchronizedSource = { online: true, synchronized: true, allowed: true } as const;
const threadScope = {
  type: "thread",
  factoryId: "factory",
  environmentId: "env-a",
  threadId: "thread-a",
} as const;
const promptIntent = (messageId: string) => ({ kind: "prompt", messageId }) as const;
const sourceEnvironment = Schema.decodeUnknownSync(FactoryEnvironmentView)({
  registrationId: "registration-a",
  environmentId: "env-a",
  endpoint: "https://unused.test",
  label: "Source",
  platform: null,
  enabled: true,
  state: "online",
  sourceAccess: {
    websocketRoute: "/factory/env/registration-a/ws",
    httpPrefix: "/factory/env/registration-a/",
    capabilities: { websocket: true, http: true },
  },
  credentialStorage: null,
  credentialExpiresAt: null,
  renewal: "unsupported",
  lastSeenAt: null,
  revision: 1,
});

describe("source action policy", () => {
  it("blocks control when the source is not synchronized", () => {
    expect(
      canControlSource({
        online: true,
        synchronized: false,
        allowed: true,
      }),
    ).toBe(false);
  });

  it("confirms rollback only from a later authoritative source snapshot", () => {
    const commandId = "rollback-1" as NonNullable<
      BoundedSnapshot["projection"]["thread"]["rollbackRequestId"]
    >;
    const action = { commandId, acceptedSequence: 12, previousStatus: "completed" } as const;
    const base = {
      snapshotSequence: 13,
      sourceStatus: "rolled_back" as const,
      projection: {
        thread: { rollbackRequestId: commandId, rollbackCompletedRequestId: commandId },
      },
    };
    expect(isRollbackCompleted(action, base)).toBe(true);
    expect(isRollbackCompleted(action, { ...base, snapshotSequence: 12 })).toBe(false);
    expect(
      isRollbackCompleted(action, {
        ...base,
        sourceStatus: "completed",
        projection: { thread: { rollbackRequestId: commandId } },
      }),
    ).toBe(false);
    expect(
      isRollbackCompleted(action, {
        ...base,
        projection: {
          thread: {
            rollbackRequestId: "other-command" as NonNullable<
              BoundedSnapshot["projection"]["thread"]["rollbackRequestId"]
            >,
          },
        },
      }),
    ).toBe(false);
  });

  it("sends no command to a stale source", async () => {
    let requests = 0;
    const dispatcher = new SourceActionRegistry();

    await expect(
      dispatcher.dispatch({
        scope: threadScope,
        intent: promptIntent("m"),
        baseSequence: 1,
        commandId: "command-stale",
        state: { online: true, synchronized: false, allowed: true },
        request: async () => {
          requests += 1;
        },
      }),
    ).rejects.toThrow("not synchronized");

    expect(requests).toBe(0);
  });

  it("passes the command ID unchanged and does not repeat an uncertain command", async () => {
    let receivedId: string | undefined;
    let requests = 0;
    const dispatcher = new SourceActionRegistry();
    const send = async (commandId: string) => {
      requests += 1;
      receivedId = commandId;
      throw new Error("connection ended before the result arrived");
    };

    await expect(
      dispatcher.dispatch({
        scope: threadScope,
        intent: promptIntent("m"),
        baseSequence: 1,
        commandId: "command-stable",
        state: synchronizedSource,
        request: send,
      }),
    ).rejects.toThrow("connection ended before the result arrived");
    await expect(
      dispatcher.dispatch({
        scope: threadScope,
        intent: promptIntent("m"),
        baseSequence: 1,
        commandId: "command-stable",
        state: synchronizedSource,
        request: send,
      }),
    ).rejects.toThrow("uncertain");

    expect(receivedId).toBe("command-stable");
    expect(requests).toBe(1);
  });

  it("does not send duplicate command IDs", async () => {
    let requests = 0;
    const dispatcher = new SourceActionRegistry();
    const send = async () => {
      requests += 1;
    };

    await dispatcher.dispatch({
      scope: threadScope,
      intent: promptIntent("command-once"),
      baseSequence: 7,
      commandId: "command-once",
      state: synchronizedSource,
      request: send,
    });
    await expect(
      dispatcher.dispatch({
        scope: threadScope,
        intent: promptIntent("command-once"),
        baseSequence: 7,
        commandId: "command-once",
        state: synchronizedSource,
        request: send,
      }),
    ).rejects.toThrow("already been sent");

    expect(requests).toBe(1);
  });

  it("confirms accepted actions only from authoritative source evidence", () => {
    const base = {
      snapshotSequence: 21,
      sourceStatus: "interrupted" as const,
      settled: false,
      hasActiveRun: false,
      userMessageIds: ["message-1"],
      runs: [{ id: "run-1", status: "interrupted" }],
    };
    expect(
      isSourceActionCompleted(
        {
          kind: "prompt",
          acceptedSequence: 21,
          messageId: "message-1",
          previousSourceStatus: "running",
          previousSettled: false,
        },
        base,
      ),
    ).toBe(true);
    expect(
      isSourceActionCompleted(
        {
          kind: "prompt",
          acceptedSequence: 21,
          messageId: "other-message",
          previousSourceStatus: "running",
          previousSettled: false,
        },
        base,
      ),
    ).toBe(false);
    expect(
      isSourceActionCompleted(
        {
          kind: "interrupt",
          runId: "run-1",
          acceptedSequence: 20,
          previousSourceStatus: "running",
          previousSettled: false,
        },
        base,
      ),
    ).toBe(true);
    expect(
      isSourceActionCompleted(
        {
          kind: "resume",
          acceptedSequence: 20,
          previousSourceStatus: "interrupted",
          previousSettled: false,
        },
        { ...base, hasActiveRun: true, sourceStatus: "running" },
      ),
    ).toBe(false);
    expect(
      isSourceActionCompleted(
        {
          kind: "resume",
          acceptedSequence: 20,
          previousSourceStatus: "interrupted",
          previousSettled: false,
        },
        { ...base, hasActiveRun: true },
      ),
    ).toBe(false);
    expect(
      isSourceActionCompleted(
        {
          kind: "settle",
          acceptedSequence: 20,
          previousSourceStatus: "running",
          previousSettled: false,
        },
        { ...base, settled: true },
      ),
    ).toBe(true);
    expect(
      isSourceActionCompleted(
        {
          kind: "unsettle",
          acceptedSequence: 20,
          previousSourceStatus: "completed",
          previousSettled: true,
        },
        base,
      ),
    ).toBe(true);
    expect(
      isSourceActionCompleted(
        {
          kind: "interrupt",
          acceptedSequence: 22,
          previousSourceStatus: "running",
          previousSettled: false,
        },
        base,
      ),
    ).toBe(false);
  });
});

it.each(["OrchestrationV2DispatchCommandError", "OrchestrationV2ThreadLaunchError"])(
  "keeps post-commit %s uncertain and blocks another ID",
  async (_tag) => {
    const dispatcher = new SourceActionRegistry();
    let requests = 0;
    await expect(
      dispatcher.dispatch({
        scope: threadScope,
        intent: promptIntent("committed"),
        baseSequence: 7,
        commandId: "committed",
        state: synchronizedSource,
        request: async () => {
          requests++;
          throw { _tag, message: "effect failed after commit" };
        },
      }),
    ).rejects.toMatchObject({ name: "SourceCommandUncertainError", commandId: "committed" });
    await expect(
      dispatcher.dispatch({
        scope: threadScope,
        intent: promptIntent("new-id"),
        baseSequence: 7,
        commandId: "new-id",
        state: synchronizedSource,
        request: async () => {
          requests++;
        },
      }),
    ).rejects.toThrow("uncertain");
    expect(requests).toBe(1);
  },
);

it("confirms queue release from the captured held runs, not an interrupted agent status", () => {
  const action = {
    kind: "resume",
    acceptedSequence: 20,
    previousSourceStatus: "completed",
    previousSettled: false,
    heldRunIds: ["held-run"],
  } as const;
  const evidence = {
    snapshotSequence: 21,
    sourceStatus: "completed",
    settled: false,
    hasActiveRun: false,
    userMessageIds: [],
    runs: [{ id: "held-run", status: "queued", queueHeld: false }],
  } as const;
  expect(isSourceActionCompleted(action, evidence)).toBe(true);
  expect(
    isSourceActionCompleted(action, {
      ...evidence,
      runs: [{ id: "held-run", status: "queued", queueHeld: true }],
    }),
  ).toBe(false);
  expect(
    isSourceActionCompleted(action, {
      ...evidence,
      hasActiveRun: true,
      sourceStatus: "running",
      runs: [{ id: "unrelated", status: "running" }],
    }),
  ).toBe(false);
});

it.live("sends zero rollback RPCs without observed native conversation support", () =>
  Effect.gen(function* () {
    let requests = 0;
    const client = new Proxy(
      {},
      {
        get() {
          return () =>
            Effect.sync(() => {
              requests++;
              return { sequence: 1 };
            });
        },
      },
    ) as SourceRpcClient;
    const owner = new SourceSessionOwner({
      isCurrent: () => true,
      getEnvironments: async () => [sourceEnvironment],
      openTransport: async () => ({ client, environmentId: "env-a", close: async () => {} }),
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => owner.invalidate()));
    const lease = yield* Effect.promise(() => owner.acquireSource("env-a"));
    yield* Effect.promise(() =>
      expect(
        dispatchSourceCommand({
          registry: new SourceActionRegistry(),
          scope: threadScope,
          lease,
          state: synchronizedSource,
          intent: { kind: "rollback", checkpointId: "checkpoint", previousStatus: "completed" },
          baseSequence: 0,
          command: {
            type: "checkpoint.rollback",
            commandId: createCommandId(),
            threadId: createThreadId(),
            checkpointId: "checkpoint" as Extract<
              Parameters<SourceRpcClient["orchestration.dispatchCommand"]>[0],
              { type: "checkpoint.rollback" }
            >["checkpointId"],
            scopeId: "scope" as Extract<
              Parameters<SourceRpcClient["orchestration.dispatchCommand"]>[0],
              { type: "checkpoint.rollback" }
            >["scopeId"],
            restoreFiles: false,
          },
        }),
      ).rejects.toThrow("not supported"),
    );
    expect(requests).toBe(0);
  }),
);

it.each(["EnvironmentAuthorizationError", "EnvironmentScopeRequiredError"])(
  "permits a new action after definitive pre-commit %s",
  async (_tag) => {
    const dispatcher = new SourceActionRegistry();
    let requests = 0;
    await expect(
      dispatcher.dispatch({
        scope: threadScope,
        intent: promptIntent("denied"),
        baseSequence: 7,
        commandId: "denied",
        state: synchronizedSource,
        request: async () => {
          requests++;
          throw { _tag, requiredScope: "factory:control" };
        },
      }),
    ).rejects.toMatchObject({ name: "SourceCommandRejectedError" });
    expect(
      await dispatcher.dispatch({
        scope: threadScope,
        intent: promptIntent("next"),
        baseSequence: 7,
        commandId: "next",
        state: synchronizedSource,
        request: async () => {
          requests++;
          return { sequence: 17 };
        },
      }),
    ).toEqual({ sequence: 17 });
    expect(requests).toBe(2);
  },
);

it("keeps uncertain outcomes distinct from acceptance and recovers only the stable command", async () => {
  const dispatcher = new SourceActionRegistry();
  let requests = 0;
  await expect(
    dispatcher.dispatch({
      scope: threadScope,
      intent: promptIntent("prompt-1"),
      baseSequence: 7,
      commandId: "prompt-1",
      state: synchronizedSource,
      request: async () => {
        requests++;
        throw new Error("Connection closed after commit");
      },
    }),
  ).rejects.toMatchObject({ name: "SourceCommandUncertainError" });
  expect(
    sourceActionResultText({ kind: "prompt", result: "uncertain", sequence: 8, complete: false }),
  ).not.toContain("Source accepted");
  await expect(
    dispatcher.dispatch({
      scope: threadScope,
      intent: promptIntent("prompt-2"),
      baseSequence: 7,
      commandId: "prompt-2",
      state: synchronizedSource,
      request: async () => {
        requests++;
      },
    }),
  ).rejects.toThrow("uncertain");
  expect(requests).toBe(1);
  const action = {
    kind: "prompt",
    acceptedSequence: 8,
    messageId: "message-1",
    previousSourceStatus: "completed",
    previousSettled: false,
  } as const;
  const snapshot = {
    snapshotSequence: 9,
    sourceStatus: "queued",
    settled: false,
    hasActiveRun: false,
    userMessageIds: ["unrelated-message"],
  } as const;
  expect(isSourceActionCompleted(action, snapshot)).toBe(false);
  expect(isSourceActionCompleted(action, { ...snapshot, userMessageIds: ["message-1"] })).toBe(
    true,
  );
  dispatcher.reconcile(threadScope, {
    type: "thread",
    snapshotSequence: 7,
    sourceStatus: "queued",
    settled: false,
    userMessageIds: ["prompt-1"],
    runs: [],
    runtimeRequests: [],
    rollbackRequestId: null,
    rollbackFailureRequestId: undefined,
  });
  await expect(
    dispatcher.dispatch({
      scope: threadScope,
      intent: promptIntent("stale"),
      baseSequence: 7,
      commandId: "stale",
      state: synchronizedSource,
      request: async () => {
        requests++;
      },
    }),
  ).rejects.toThrow("uncertain");
  dispatcher.reconcile(threadScope, {
    type: "thread",
    snapshotSequence: 9,
    sourceStatus: "queued",
    settled: false,
    userMessageIds: ["prompt-1"],
    runs: [],
    runtimeRequests: [],
    rollbackRequestId: null,
    rollbackFailureRequestId: undefined,
  });
  expect(
    dispatcher
      .records(sourceActionScopeKey(threadScope))
      .find((record) => record.commandId === "prompt-1")?.phase,
  ).toBe("confirmed");
  expect(requests).toBe(1);
  await expect(
    dispatcher.dispatch({
      scope: threadScope,
      intent: promptIntent("prompt-1"),
      baseSequence: 7,
      commandId: "prompt-1",
      state: synchronizedSource,
      request: async () => {
        requests++;
      },
    }),
  ).rejects.toThrow("already been sent");
  expect(
    await dispatcher.dispatch({
      scope: threadScope,
      intent: promptIntent("prompt-2"),
      baseSequence: 7,
      commandId: "prompt-2",
      state: synchronizedSource,
      request: async () => {
        requests++;
        return { sequence: 10 };
      },
    }),
  ).toEqual({ sequence: 10 });
  expect(
    sourceActionResultText({ kind: "prompt", result: "accepted", sequence: 10, complete: false }),
  ).toContain("Source accepted prompt at sequence 10");
  expect(
    sourceActionResultText({ kind: "prompt", result: "confirmed", sequence: 11, complete: true }),
  ).toContain("Source update confirms prompt");
  expect(requests).toBe(2);
});

const nativeSupport = {
  providers: [{ instanceId: "provider", supportsConversationRollback: true }],
  projection: {
    thread: { modelSelection: { instanceId: "provider" }, activeProviderThreadId: "native-thread" },
    providerThreads: [
      { id: "native-thread", providerInstanceId: "provider", providerSessionId: "native-session" },
    ],
    providerSessions: [
      {
        id: "native-session",
        providerInstanceId: "provider",
        capabilities: { threads: { canRollbackThread: true } },
      },
    ],
    runs: [{ id: "held", status: "queued", queueHeld: true }],
  },
} as const;

it.live("requires both source config and matching active native rollback support before RPC", () =>
  Effect.gen(function* () {
    const commands: unknown[] = [];
    const client = new Proxy(
      {},
      {
        get() {
          return (command: unknown) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: 30 };
            });
        },
      },
    ) as SourceRpcClient;
    const owner = new SourceSessionOwner({
      isCurrent: () => true,
      getEnvironments: async () => [sourceEnvironment],
      openTransport: async () => ({ client, environmentId: "env-a", close: async () => {} }),
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => owner.invalidate()));
    const lease = yield* Effect.promise(() => owner.acquireSource("env-a"));
    const command = {
      type: "checkpoint.rollback",
      commandId: createCommandId(),
      threadId: createThreadId(),
      checkpointId: "checkpoint" as Extract<
        Parameters<SourceRpcClient["orchestration.dispatchCommand"]>[0],
        { type: "checkpoint.rollback" }
      >["checkpointId"],
      scopeId: "scope" as Extract<
        Parameters<SourceRpcClient["orchestration.dispatchCommand"]>[0],
        { type: "checkpoint.rollback" }
      >["scopeId"],
      restoreFiles: false,
    } as const;
    for (const evidence of [
      {
        ...nativeSupport,
        providers: [{ instanceId: "provider", supportsConversationRollback: false }],
      },
      {
        ...nativeSupport,
        projection: {
          ...nativeSupport.projection,
          providerSessions: [
            {
              id: "native-session",
              providerInstanceId: "provider",
              capabilities: { threads: { canRollbackThread: false } },
            },
          ],
        },
      },
      { ...nativeSupport, projection: { ...nativeSupport.projection, providerThreads: [] } },
      {
        ...nativeSupport,
        projection: {
          ...nativeSupport.projection,
          providerSessions: [
            {
              ...nativeSupport.projection.providerSessions[0],
              providerInstanceId: "other-provider",
            },
          ],
        },
      },
    ])
      yield* Effect.promise(() =>
        expect(
          dispatchSourceCommand({
            registry: new SourceActionRegistry(),
            scope: threadScope,
            lease,
            state: synchronizedSource,
            command,
            intent: { kind: "rollback", checkpointId: "checkpoint", previousStatus: "completed" },
            baseSequence: 0,
            support: evidence,
          }),
        ).rejects.toThrow("not supported"),
      );
    expect(commands).toEqual([]);
    expect(
      yield* Effect.promise(() =>
        dispatchSourceCommand({
          registry: new SourceActionRegistry(),
          scope: threadScope,
          lease,
          state: synchronizedSource,
          command,
          intent: { kind: "rollback", checkpointId: "checkpoint", previousStatus: "completed" },
          baseSequence: 0,
          support: nativeSupport,
        }),
      ),
    ).toEqual({ sequence: 30 });
    expect(commands).toEqual([command]);
  }),
);

it.live(
  "only releases an observed held queue, preserving the command ID and native queue command",
  () =>
    Effect.gen(function* () {
      const commands: unknown[] = [];
      const client = new Proxy(
        {},
        {
          get() {
            return (command: unknown) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: 31 };
              });
          },
        },
      ) as SourceRpcClient;
      const owner = new SourceSessionOwner({
        isCurrent: () => true,
        getEnvironments: async () => [sourceEnvironment],
        openTransport: async () => ({ client, environmentId: "env-a", close: async () => {} }),
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => owner.invalidate()));
      const lease = yield* Effect.promise(() => owner.acquireSource("env-a"));
      const command = {
        type: "queue.resume",
        commandId: createCommandId(),
        threadId: createThreadId(),
      } as const;
      for (const runs of [
        [],
        [{ id: "interrupted", status: "interrupted" }],
        [{ id: "queued", status: "queued", queueHeld: false }],
      ]) {
        yield* Effect.promise(() =>
          expect(
            dispatchSourceCommand({
              registry: new SourceActionRegistry(),
              scope: threadScope,
              lease,
              state: synchronizedSource,
              command,
              intent: { kind: "resume", heldRunIds: ["held"] },
              baseSequence: 0,
              support: { ...nativeSupport, projection: { ...nativeSupport.projection, runs } },
            }),
          ).rejects.toThrow("not supported"),
        );
      }
      expect(commands).toEqual([]);
      expect(
        yield* Effect.promise(() =>
          dispatchSourceCommand({
            registry: new SourceActionRegistry(),
            scope: threadScope,
            lease,
            state: synchronizedSource,
            command,
            intent: { kind: "resume", heldRunIds: ["held"] },
            baseSequence: 0,
            support: nativeSupport,
          }),
        ),
      ).toEqual({ sequence: 31 });
      expect(commands).toEqual([command]);
      expect(
        sourceActionResultText({
          kind: "resume",
          result: "accepted",
          sequence: 31,
          complete: false,
        }),
      ).toContain("queue release");
    }),
);

it("keeps a lease authorization failure after native dispatch uncertain", async () => {
  const dispatcher = new SourceActionRegistry();
  await expect(
    dispatcher.dispatch({
      scope: threadScope,
      intent: promptIntent("lease-lost-after-commit"),
      baseSequence: 7,
      commandId: "lease-lost-after-commit",
      state: synchronizedSource,
      request: async () => {
        throw { _tag: "SourceLeaseError", reason: "authorization" };
      },
    }),
  ).rejects.toMatchObject({ name: "SourceCommandUncertainError" });
});

it("does not confirm an interrupt from an unrelated thread status transition", () => {
  expect(
    isSourceActionCompleted(
      {
        kind: "interrupt",
        acceptedSequence: 3,
        previousSourceStatus: "running",
        previousSettled: false,
      },
      {
        snapshotSequence: 4,
        sourceStatus: "interrupted",
        settled: false,
        hasActiveRun: false,
        userMessageIds: [],
        runs: [],
      },
    ),
  ).toBe(false);
});

it("does not authorize rollback using an old provider instead of the selected native model", () => {
  const evidence = {
    ...nativeSupport,
    projection: {
      ...nativeSupport.projection,
      thread: {
        ...nativeSupport.projection.thread,
        modelSelection: { instanceId: "selected-provider" },
      },
    },
  };
  expect(rollbackUnavailableReason(evidence)).toBeDefined();
});

it("keeps same-ordinal newer provider updates pending until the matching rollback completion", () => {
  const action = {
    commandId: "rollback",
    acceptedSequence: 20,
    previousStatus: "completed",
  } as const;
  const snapshot = {
    snapshotSequence: 21,
    sourceStatus: "completed",
    projection: {
      thread: { rollbackRequestId: "rollback" },
      providerThreads: [
        { id: "native-thread", lastRunOrdinal: 1, updatedAt: DateTime.makeUnsafe(101) },
      ],
    },
  } as const;
  expect(isRollbackCompleted(action, snapshot)).toBe(false);
  const completed = {
    ...snapshot,
    projection: {
      ...snapshot.projection,
      thread: { rollbackRequestId: "rollback", rollbackCompletedRequestId: "rollback" },
    },
  };
  expect(isRollbackCompleted(action, completed)).toBe(true);
  expect(isRollbackCompleted(action, { ...completed, sourceStatus: "rolled_back" })).toBe(true);
  expect(
    isRollbackCompleted(action, {
      ...completed,
      projection: {
        ...completed.projection,
        thread: { rollbackRequestId: "rollback", rollbackCompletedRequestId: "other" },
      },
    }),
  ).toBe(false);
  expect(isRollbackCompleted(action, { ...snapshot, snapshotSequence: 20 })).toBe(false);
  expect(
    isRollbackCompleted(action, {
      ...snapshot,
      projection: { ...snapshot.projection, thread: { rollbackRequestId: "other" } },
    }),
  ).toBe(false);
});

it("reconciles uncertain rollback and confirmed copy only from the explicit completion ID", async () => {
  const registry = new SourceActionRegistry();
  await expect(
    registry.dispatch({
      scope: threadScope,
      intent: { kind: "rollback", checkpointId: "real-checkpoint", previousStatus: "completed" },
      commandId: "uncertain-rollback",
      baseSequence: 7,
      state: synchronizedSource,
      request: async () => {
        throw new Error("lost receipt");
      },
    }),
  ).rejects.toThrow("uncertain");
  const observation = {
    type: "thread",
    snapshotSequence: 9,
    sourceStatus: "rolled_back",
    settled: false,
    userMessageIds: [],
    runs: [],
    runtimeRequests: [],
    rollbackRequestId: "uncertain-rollback",
    rollbackFailureRequestId: undefined,
  } as const;
  const key = sourceActionScopeKey(threadScope);
  registry.reconcile(threadScope, observation);
  expect(registry.records(key)[0].phase).toBe("uncertain");
  expect(sourceActionRecordText(registry.records(key)[0])).toContain("Do not repeat");
  registry.reconcile(threadScope, { ...observation, rollbackCompletedRequestId: "other" });
  expect(registry.records(key)[0].phase).toBe("uncertain");
  registry.reconcile(threadScope, {
    ...observation,
    rollbackCompletedRequestId: "uncertain-rollback",
  });
  expect(registry.records(key)[0].phase).toBe("confirmed");
  expect(sourceActionRecordText(registry.records(key)[0])).toContain(
    "completed rollback command uncertain-rollback",
  );
});
