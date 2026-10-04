import {
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderSession,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ProviderDriver } from "../../provider/ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../../provider/providerMaintenance.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2TurnInput,
} from "../../orchestration-v2/ProviderAdapter.ts";

export const controlledRollbackBarriers = new Map<string, Effect.Effect<void>>();

/** Only the external provider SPI is controlled. Policy, intake, worker and projections stay real. */
export function controlledProviderDriver(slug: string, rollback: boolean): ProviderDriver<{}> {
  const driver = ProviderDriverKind.make(slug);
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    threads: { ...CodexProviderCapabilitiesV2.threads, canRollbackThread: rollback },
  };
  return {
    driverKind: driver,
    metadata: { displayName: `Controlled ${slug}` },
    configSchema: Schema.Struct({}),
    defaultConfig: () => ({}),
    create: (input) =>
      Effect.sync(() => {
        const snapshot = ServerProvider.make({
          instanceId: input.instanceId,
          driver,
          displayName: `Controlled ${slug}`,
          enabled: input.enabled,
          installed: true,
          version: "phase2-fixture",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-10-04T00:00:00.000Z",
          supportsConversationRollback: rollback,
          supportedRuntimeModes: ["full-access"],
          supportsTextGeneration: false,
          models: [
            {
              slug: "controlled-model",
              name: "Controlled model",
              isCustom: false,
              isDefault: true,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "effort",
                    label: "Effort",
                    type: "select",
                    options: [
                      { id: "low", label: "Low", isDefault: true },
                      { id: "high", label: "High" },
                    ],
                  },
                  { id: "fast", label: "Fast", type: "boolean", currentValue: false },
                ],
              },
            },
          ],
          slashCommands: [],
          skills: [],
        });
        return {
          instanceId: input.instanceId,
          driverKind: driver,
          continuationIdentity: {
            driverKind: driver,
            continuationKey: `phase2:${input.instanceId}`,
          },
          displayName: input.displayName,
          enabled: input.enabled,
          snapshot: {
            getSnapshot: Effect.succeed(snapshot),
            refresh: Effect.succeed(snapshot),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: driver,
                  packageName: null,
                }),
              ),
          },
          textGeneration: {
            generateThreadTitle: () => Effect.succeed({ title: "Controlled title" }),
            generateBranchName: () => Effect.succeed({ branch: "controlled" }),
            generateCommitMessage: () => Effect.die("No text generation in phase2 gate"),
            generatePrContent: () => Effect.die("No PR generation in phase2 gate"),
          },
          orchestrationAdapter: {
            instanceId: input.instanceId,
            driver,
            getCapabilities: () => Effect.succeed(capabilities),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
            openSession: (sessionInput) =>
              Effect.gen(function* () {
                const now = yield* DateTime.now;
                const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
                const turns = new Map<string, ProviderAdapterV2TurnInput>();
                const providerSession = OrchestrationV2ProviderSession.make({
                  id: sessionInput.providerSessionId,
                  driver,
                  providerInstanceId: input.instanceId,
                  status: "ready",
                  cwd: sessionInput.runtimePolicy.cwd ?? "/",
                  model: sessionInput.modelSelection.model,
                  capabilities,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                });
                const emit = (event: ProviderAdapterV2Event) =>
                  Queue.offer(events, event).pipe(Effect.asVoid);
                const finish = (
                  turn: ProviderAdapterV2TurnInput,
                  status: "completed" | "interrupted",
                ) =>
                  Effect.gen(function* () {
                    const completedAt = yield* DateTime.now;
                    yield* emit({
                      type: "provider_turn.updated",
                      driver,
                      threadId: turn.threadId,
                      providerTurn: {
                        id: ProviderTurnId.make(`turn:${turn.runId}`),
                        providerThreadId: turn.providerThread.id,
                        nodeId: turn.rootNodeId,
                        runAttemptId: turn.attemptId,
                        nativeTurnRef: null,
                        ordinal: turn.providerTurnOrdinal,
                        status,
                        startedAt: now,
                        completedAt,
                      },
                    });
                    yield* emit({
                      type: "turn.terminal",
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId: ProviderTurnId.make(`turn:${turn.runId}`),
                      runOrdinal: turn.runOrdinal,
                      status,
                      failure: null,
                      threadDisposition: "reusable",
                    });
                  });
                const runtime: ProviderAdapterV2SessionRuntime = {
                  instanceId: input.instanceId,
                  driver,
                  providerSessionId: providerSession.id,
                  providerSession,
                  events: Stream.fromQueue(events),
                  ensureThread: (threadInput) =>
                    Effect.succeed(
                      OrchestrationV2ProviderThread.make({
                        id:
                          threadInput.existingProviderThread?.id ??
                          ProviderThreadId.make(`provider:${threadInput.threadId}`),
                        driver,
                        providerInstanceId: input.instanceId,
                        providerSessionId: providerSession.id,
                        appThreadId: threadInput.threadId,
                        ownerNodeId: null,
                        nativeThreadRef: null,
                        nativeConversationHeadRef: null,
                        status: "idle",
                        firstRunOrdinal: null,
                        lastRunOrdinal: null,
                        handoffIds: [],
                        forkedFrom: null,
                        createdAt: now,
                        updatedAt: now,
                      }),
                    ),
                  resumeThread: (args) =>
                    Effect.succeed({
                      ...args.providerThread,
                      providerSessionId: providerSession.id,
                    }),
                  startTurn: (turn) =>
                    Effect.gen(function* () {
                      turns.set(`turn:${turn.runId}`, turn);
                      yield* emit({
                        type: "provider_turn.updated",
                        driver,
                        threadId: turn.threadId,
                        providerTurn: {
                          id: ProviderTurnId.make(`turn:${turn.runId}`),
                          providerThreadId: turn.providerThread.id,
                          nodeId: turn.rootNodeId,
                          runAttemptId: turn.attemptId,
                          nativeTurnRef: null,
                          ordinal: turn.providerTurnOrdinal,
                          status: "running",
                          startedAt: now,
                          completedAt: null,
                        },
                      });
                      if (!turn.message.text.startsWith("hold")) yield* finish(turn, "completed");
                    }),
                  steerTurn: () => Effect.die("Steering is not used by phase2 gate"),
                  interruptTurn: (args) => {
                    const turn = turns.get(args.providerTurnId);
                    return turn === undefined
                      ? Effect.die("Unknown controlled turn")
                      : finish(turn, "interrupted");
                  },
                  respondToRuntimeRequest: () => Effect.void,
                  readThreadSnapshot: (args) =>
                    Effect.succeed({
                      providerThread: args.providerThread,
                      providerTurns: [],
                      messages: [],
                      runtimeRequests: [],
                    }),
                  rollbackThread: (args) =>
                    rollback
                      ? (
                          (args.providerThread.appThreadId === null
                            ? undefined
                            : controlledRollbackBarriers.get(args.providerThread.appThreadId)) ??
                          Effect.void
                        ).pipe(
                          Effect.as({
                            providerThread: args.providerThread,
                            providerTurns: [],
                            messages: [],
                            runtimeRequests: [],
                          }),
                        )
                      : Effect.die("Unsupported provider rollback reached external runtime"),
                  forkThread: () => Effect.die("Fork is phase3/out of this gate"),
                };
                return runtime;
              }),
          },
        };
      }),
  };
}
