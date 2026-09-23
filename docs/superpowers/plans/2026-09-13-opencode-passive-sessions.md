# OpenCode Passive Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a new T3 Code OpenCode thread select a matching existing upstream session or create a new one, while OpenCode exclusively owns conversation context.

**Architecture:** Carry an OpenCode-only session source on the first `thread.turn.start` command and turn it into the adapter's durable resume cursor. Expose read-only session discovery through a typed WebSocket RPC, store the user's pre-send choice in the existing web and mobile composer drafts, import selected-session messages once as display events, and remove OpenCode adapter paths that mutate or rebuild upstream history.

**Tech Stack:** TypeScript, Effect, Effect Schema/RPC, OpenCode SDK v2, WebSocket RPC, React/Vite, React Native, Vite Plus tests.

**Implementation status:** Implemented in `f7492bb43abd68dc44dc4a00cfda1a33a5910678`
(`feat(opencode): support passive session workflows`). The implementation also
includes the startup/reconciliation safeguards and usage telemetry recorded in
the follow-up evidence below. The checkbox steps remain the historical
red-green sequence used while developing the change.

## Global Constraints

- Support web and mobile; desktop inherits the web implementation.
- Only an untouched thread may select an upstream OpenCode session; source changes after the first prompt are unsupported.
- Discover sessions only for the canonical selected project directory, newest first, with a bounded result set.
- Default to a new OpenCode session; discovery failure must not block that path.
- Selected upstream sessions are validated exactly; a missing or mismatched session must never fall back to a new or forked session.
- Import historical messages once for display only. Never replay imported content into a prompt or construct OpenCode context in T3 Code.
- Preserve T3 Code runtime permission modes and map approval responses only to OpenCode-supported scopes.
- OpenCode must not advertise rollback or compaction and must not call `session.fork` or `session.summarize`.
- Retain the OpenCode version floor of `1.14.19`.
- Do not run repository-wide checks. Use focused tests and targeted typechecks only.

---

## File Structure

- `packages/contracts/src/provider.ts`: defines `OpenCodeSessionSource`, picker session metadata, and adds the source to provider session start input.
- `packages/contracts/src/rpc.ts`: exposes a typed `opencode.listSessions` RPC request and response.
- `packages/contracts/src/orchestration.ts`: carries the selected source through the first turn-start command.
- `apps/server/src/provider/opencodeRuntime.ts`: executes and parses the OpenCode session-list CLI command.
- `apps/server/src/provider/Layers/OpenCodeAdapter.ts`: validates/adopts sources, imports historical display messages, persists the ID, and removes history-mutating capabilities.
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`: forwards the first-turn source to `ProviderService.startSession`.
- `apps/server/src/ws.ts`: serves the session-list RPC with provider-instance and project-directory validation.
- `apps/web/src/components/chat/ChatComposer.tsx` and a focused adjacent picker component: display and persist the web draft selector.
- `apps/mobile/src/state/use-composer-drafts.ts`, `apps/mobile/src/features/threads/new-task-flow-provider.tsx`, `apps/mobile/src/features/threads/NewTaskDraftScreen.tsx`, and a focused selector component: persist and render the mobile draft selector.
- `docs/user/providers-opencode.md`: describes session selection, OpenCode context ownership, and approvals.

### Task 1: Define Session-Source Contracts And First-Turn Transport

**Files:**

- Modify: `packages/contracts/src/provider.ts`
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/provider.test.ts`
- Modify: `packages/contracts/src/orchestration.test.ts`
- Test: `packages/contracts/src/rpc.test.ts`

**Interfaces:**

- Produces `OpenCodeSessionSource = { type: "new" } | { type: "existing"; sessionId: string }`.
- Produces `OpenCodeSessionListEntry` with `id`, `title`, `directory`, `createdAt`, `updatedAt`, and optional `model`/`agent` metadata.
- Adds optional `openCodeSessionSource?: OpenCodeSessionSource` to `ProviderSessionStartInput` and `ThreadTurnStartCommand`.
- Produces `WS_METHODS.openCodeListSessions` with `{ instanceId, cwd }` input and `{ sessions: ReadonlyArray<OpenCodeSessionListEntry> }` output.

- [ ] **Step 1: Write failing schema tests for both source variants and rejection cases**

```ts
it("decodes an existing OpenCode source only with a non-empty session id", () => {
  expect(
    decodeProviderSessionStartInput({
      threadId: ThreadId.make("thread"),
      providerInstanceId: ProviderInstanceId.make("opencode"),
      runtimeMode: "approval-required",
      openCodeSessionSource: { type: "existing", sessionId: "ses_123" },
    }).openCodeSessionSource,
  ).toEqual({ type: "existing", sessionId: "ses_123" });

  expect(() =>
    decodeProviderSessionStartInput({
      threadId: ThreadId.make("thread"),
      runtimeMode: "approval-required",
      openCodeSessionSource: { type: "existing", sessionId: "   " },
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the focused contract test and confirm the new field is absent**

Run: `vp test run packages/contracts/src/provider.test.ts`

Expected: failure because `openCodeSessionSource` is not yet part of the schema.

- [ ] **Step 3: Add discriminated schemas and thread-turn transport**

```ts
export const OpenCodeSessionSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("new") }),
  Schema.Struct({ type: Schema.Literal("existing"), sessionId: TrimmedNonEmptyString }),
]);

export const OpenCodeSessionListEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  directory: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  model: Schema.optional(TrimmedNonEmptyString),
  agent: Schema.optional(TrimmedNonEmptyString),
});
```

Add the optional source to `ProviderSessionStartInput` and `ThreadTurnStartCommand`; add the RPC beside the existing provider-scoped RPC declarations in `rpc.ts`. Keep the source optional for older clients and validate it as OpenCode-only in the server reactor rather than baking provider identity into the shared schema.

- [ ] **Step 4: Add round-trip RPC and command tests**

```ts
expect(
  decodeThreadTurnStart({ ...baseTurn, openCodeSessionSource: { type: "new" } })
    .openCodeSessionSource,
).toEqual({ type: "new" });
expect(
  encodeWsOpenCodeListSessions({
    instanceId: ProviderInstanceId.make("opencode"),
    cwd: "/repo",
  }),
).toEqual({ instanceId: "opencode", cwd: "/repo" });
```

- [ ] **Step 5: Run focused contract tests**

Run: `vp test run packages/contracts/src/provider.test.ts packages/contracts/src/orchestration.test.ts packages/contracts/src/rpc.test.ts`

Expected: all affected contract tests pass.

### Task 2: Discover Sessions Through OpenCode Without Mutation

**Files:**

- Modify: `apps/server/src/provider/opencodeRuntime.ts`
- Modify: `apps/server/src/provider/opencodeRuntime.cliParsers.test.ts`
- Modify: `apps/server/src/provider/opencodeRuntime.inventory.test.ts`
- Modify: `apps/server/src/ws.ts`
- Test: `apps/server/src/ws.test.ts` or the existing test file for provider RPC handlers

**Interfaces:**

- Consumes `OpenCodeSessionListEntry` and `WS_METHODS.openCodeListSessions` from Task 1.
- Produces `OpenCodeRuntime.listOpenCodeSessions({ binaryPath, cwd, environment })`.
- Produces the `opencode.listSessions` RPC handler, restricted to enabled OpenCode provider instances.

- [ ] **Step 1: Write failing CLI parser tests using representative JSON output**

```ts
it("keeps only sessions for the requested directory and orders newest first", () => {
  expect(
    parseOpenCodeSessionListCliOutput(
      JSON.stringify([
        { id: "ses_old", directory: "/repo", updatedAt: "2026-09-10T00:00:00.000Z" },
        { id: "ses_other", directory: "/other", updatedAt: "2026-09-12T00:00:00.000Z" },
        { id: "ses_new", directory: "/repo", updatedAt: "2026-09-12T00:00:00.000Z" },
      ]),
      "/repo",
    ).map((session) => session.id),
  ).toEqual(["ses_new", "ses_old"]);
});
```

- [ ] **Step 2: Run the parser test and confirm it fails**

Run: `vp test run apps/server/src/provider/opencodeRuntime.cliParsers.test.ts`

Expected: failure because the session-list parser does not exist.

- [ ] **Step 3: Add the serialized OpenCode CLI call and strict parser**

Add `listOpenCodeSessions` to `OpenCodeRuntimeShape`. Invoke the supported OpenCode CLI session-list command in `cwd`, request JSON output, and reuse `runOpenCodeCommand`. Decode only fields needed by `OpenCodeSessionListEntry`; skip malformed records rather than returning untyped CLI data. Canonicalize the requested and reported directories using the same `FileSystem.realPath` fallback behavior already used by `isSameOpenCodeDirectory`, filter exact matches, order by `updatedAt` descending, and cap the result with a named constant.

```ts
const OPENCODE_SESSION_LIST_LIMIT = 100;

const matching = decoded.filter((session) => sameCanonicalDirectory(session.directory, input.cwd));
return matching
  .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  .slice(0, OPENCODE_SESSION_LIST_LIMIT);
```

- [ ] **Step 4: Add the WebSocket handler and its authorization tests**

Resolve `input.instanceId`, reject non-OpenCode or disabled instances with the existing provider setup error shape, then call the runtime using the instance binary/configuration and requested project cwd. Test a valid OpenCode instance, non-OpenCode instance, disabled instance, malformed CLI output, and CLI failure. The response must be a typed empty/error result as defined by the RPC, never an unhandled process exception.

- [ ] **Step 5: Run focused server tests**

Run: `vp test run apps/server/src/provider/opencodeRuntime.cliParsers.test.ts apps/server/src/provider/opencodeRuntime.inventory.test.ts apps/server/src/ws.test.ts`

Expected: parser, filtering, bounds, authorization, and RPC failure tests pass.

### Task 3: Make The Adapter Passive And Import Existing Transcripts Once

**Files:**

- Modify: `apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- Modify: `apps/server/src/provider/Layers/OpenCodeAdapter.test.ts`
- Modify: `apps/server/src/provider/opencodeRuntime.permissions.test.ts`
- Modify: `apps/server/src/provider/Services/ProviderAdapter.ts` only if a narrow capability is required to mark transcript import

**Interfaces:**

- Consumes `ProviderSessionStartInput.openCodeSessionSource` from Task 1.
- Produces an OpenCode `resumeCursor` containing the exact adopted or created upstream ID.
- Produces imported user/assistant display events before the first live prompt for an existing source.
- Advertises `{ sessionModelSwitch: "in-session", supportsConversationRollback: false }` and no `compaction` capability.

- [ ] **Step 1: Write failing adapter tests for passive adoption and absent mutation calls**

```ts
it.effect("adopts the selected session, imports it once, and never forks or summarizes", () =>
  Effect.gen(function* () {
    const adapter = yield* OpenCodeAdapter;
    const session = yield* adapter.startSession({
      threadId,
      providerInstanceId,
      cwd: "/repo",
      runtimeMode: "approval-required",
      openCodeSessionSource: { type: "existing", sessionId: "ses_existing" },
    });

    expect(session.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "ses_existing" });
    expect(mock.session.get).toHaveBeenCalledWith({ sessionID: "ses_existing" });
    expect(mock.session.messages).toHaveBeenCalledTimes(1);
    expect(mock.session.fork).not.toHaveBeenCalled();
    expect(mock.session.summarize).not.toHaveBeenCalled();
  }),
);
```

Also add tests for a missing selected ID, directory mismatch, one transient `session.get` failure, new source creation, resume after an in-memory restart, and unchanged permission update/reply behavior for adopted sessions.

- [ ] **Step 2: Run the focused adapter test and confirm it fails**

Run: `vp test run apps/server/src/provider/Layers/OpenCodeAdapter.test.ts`

Expected: failure because session source is ignored and passive capabilities are absent.

- [ ] **Step 3: Replace resume/fork resolution with exact source resolution**

In `startSession`, select in this order: an explicit existing source for the first start, then a persisted resume cursor for recovery, then a new source. For existing/resume IDs, call `session.get`, reject confirmed 404s and directory mismatches as `ProviderAdapterRequestError`, and propagate all other failures. Do not call `session.fork`. For `new`, call `session.create` once. Continue applying `buildOpenCodePermissionRules(input.runtimeMode)` to the resolved session.

```ts
const requestedSessionId =
  input.openCodeSessionSource?.type === "existing"
    ? input.openCodeSessionSource.sessionId
    : parseOpenCodeResume(input.resumeCursor)?.sessionId;

if (requestedSessionId) {
  const adopted = yield * getRequiredOpenCodeSession(client, requestedSessionId);
  yield * requireSameOpenCodeDirectory(adopted.directory, directory);
  yield * updateOpenCodePermissionRules(client, adopted.id, input.runtimeMode);
  return { openCodeSession: adopted, created: false, importTranscript: true };
}
```

- [ ] **Step 4: Project historical messages as read-only display events**

Create one helper that maps the `session.messages` response into existing canonical runtime user/assistant message and activity event shapes. Call it only for an explicit existing source, before the first live prompt is admitted. Preserve upstream message IDs as stable provider item IDs, mark imported activity as historical so the projector does not create a new turn-start request, and never feed the mapped text into `sendTurn` or `buildRuntimeInstructions`.

Add a test asserting a second prompt and a reaper/restart do not re-import the same transcript after the resume cursor is already persisted.

- [ ] **Step 5: Remove OpenCode history ownership**

Delete `compactThread`, remove the `compaction` property, and change `rollbackThread` to return the standard unsupported-provider request error without reading messages or forking. Remove snapshot/revert bookkeeping that exists only for rollback. Set `supportsConversationRollback: false`.

```ts
capabilities: {
  sessionModelSwitch: "in-session",
  supportsConversationRollback: false,
},
// No compaction property.
```

- [ ] **Step 6: Run focused adapter and permission tests**

Run: `vp test run apps/server/src/provider/Layers/OpenCodeAdapter.test.ts apps/server/src/provider/opencodeRuntime.permissions.test.ts`

Expected: passive adoption, single import, no fork/summarize, unsupported rollback/compaction, and approval mapping tests pass.

### Task 4: Route The First-Turn Selection And Persist Draft State

**Files:**

- Modify: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- Modify: `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx`
- Modify: web composer draft state file(s) identified by `ChatComposer` imports
- Modify: `apps/mobile/src/state/use-composer-drafts.ts`
- Modify: `apps/mobile/src/features/threads/new-task-flow-provider.tsx`
- Modify: `apps/mobile/src/lib/projectThreadStartTurn.ts`
- Test: `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
- Test: focused web composer logic test file
- Test: `apps/mobile/src/state/use-composer-drafts.test.ts` and `apps/mobile/src/lib/projectThreadStartTurn.test.ts`

**Interfaces:**

- Consumes `ThreadTurnStartCommand.openCodeSessionSource` from Task 1.
- Produces `ProviderSessionStartInput.openCodeSessionSource` only when the desired driver is OpenCode and no active provider session exists.
- Produces persisted web/mobile draft `openCodeSessionSource?: OpenCodeSessionSource` and includes it in the first turn command.

- [ ] **Step 1: Write a failing reactor test proving the source reaches only the first OpenCode start**

```ts
expect(startSession).toHaveBeenCalledWith(
  threadId,
  expect.objectContaining({
    openCodeSessionSource: { type: "existing", sessionId: "ses_existing" },
  }),
);
expect(startSession).toHaveBeenCalledTimes(1);
```

Add a companion test for a non-OpenCode selected instance that fails with a validation error rather than forwarding the field.

- [ ] **Step 2: Run the reactor test and confirm it fails**

Run: `vp test run apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`

Expected: failure because the reactor does not forward the selection.

- [ ] **Step 3: Forward and guard the source in the reactor**

When the command begins a provider session, require that `openCodeSessionSource` is absent unless `desiredInfo.driverKind === "opencode"`; pass it to `providerService.startSession` only for a new provider session. If the thread already has an active session, reject any supplied source instead of allowing a hidden session switch.

- [ ] **Step 4: Extend draft persistence and turn payload builders**

Add the optional field to the web and mobile composer draft schema/type. Update each first-turn payload builder to include it only if the selected provider is OpenCode and the target thread has no prior message/session. Clear it when model selection changes to another provider instance or the selected project/worktree changes. Do not clear it on a failed send.

```ts
const openCodeSessionSource = isNewOpenCodeThread({ thread, modelSelection })
  ? draft.openCodeSessionSource
  : undefined;

sendTurn({ ...payload, ...(openCodeSessionSource ? { openCodeSessionSource } : {}) });
```

- [ ] **Step 5: Add focused persistence and immutability tests**

Test that drafts restore an existing source, provider/project changes clear it, failed sends retain it, successful first sends make the selector read-only, and later turns omit the field. Test desktop indirectly through the web composer path.

- [ ] **Step 6: Run focused server and draft tests**

Run: `vp test run apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts apps/mobile/src/state/use-composer-drafts.test.ts apps/mobile/src/lib/projectThreadStartTurn.test.ts`

Expected: first-turn routing and mobile draft tests pass. Run the identified web composer test file after its selector logic is added.

### Task 5: Build The Web And Mobile Session Pickers

**Files:**

- Create: `apps/web/src/components/chat/OpenCodeSessionPicker.tsx`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx`
- Create: `apps/web/src/components/chat/OpenCodeSessionPicker.test.tsx`
- Create: `apps/mobile/src/features/threads/OpenCodeSessionPicker.tsx`
- Modify: `apps/mobile/src/features/threads/ThreadComposer.tsx`
- Modify: `apps/mobile/src/features/threads/NewTaskDraftScreen.tsx`
- Create: `apps/mobile/src/features/threads/OpenCodeSessionPicker.test.tsx`

**Interfaces:**

- Consumes `WS_METHODS.openCodeListSessions` from Task 1 through each platform's existing RPC client.
- Consumes and updates draft `OpenCodeSessionSource` from Task 4.
- Produces the same picker states on both platforms: default new, loading, searchable matching sessions, retryable error, and fixed selected-session metadata after first prompt.

- [ ] **Step 1: Write failing web picker behavior tests**

```tsx
render(
  <OpenCodeSessionPicker
    source={{ type: "new" }}
    sessions={[session("ses_1", "Fix parser")]}
    onSourceChange={onSourceChange}
  />,
);

await user.click(screen.getByRole("button", { name: /new opencode session/i }));
await user.click(await screen.findByRole("option", { name: /fix parser/i }));
expect(onSourceChange).toHaveBeenCalledWith({ type: "existing", sessionId: "ses_1" });
```

Include tests for empty matching sessions, search filtering, a retryable load failure, refresh, and `disabled` rendering after the first prompt.

- [ ] **Step 2: Run the web picker test and confirm it fails**

Run: `vp test run apps/web/src/components/chat/OpenCodeSessionPicker.test.tsx`

Expected: failure because the component does not exist.

- [ ] **Step 3: Implement the web picker and integrate it into the untouched composer**

Use established web select/popover primitives and query invalidation patterns. Fetch only while the chosen provider driver is OpenCode, a project cwd exists, and the thread is untouched. Render New OpenCode session as the first option, retain the draft source during a refresh, and show non-blocking retry copy when RPC discovery fails. After the first prompt, render the selected upstream ID/title as static metadata and do not mount an interactive selector.

- [ ] **Step 4: Write failing mobile picker behavior tests**

```tsx
render(
  <OpenCodeSessionPicker
    source={{ type: "new" }}
    sessions={[session("ses_1", "Fix parser")]}
    editable
    onSourceChange={onSourceChange}
  />,
);

fireEvent.press(screen.getByText("Fix parser"));
expect(onSourceChange).toHaveBeenCalledWith({ type: "existing", sessionId: "ses_1" });
```

Cover the same new, list, search, refresh, error, provider-change clearing, and locked-after-send states as web.

- [ ] **Step 5: Implement the mobile picker and integrate it with draft settings**

Use the mobile thread settings/new-task presentation conventions rather than a desktop-style dropdown. Fetch only for an untouched OpenCode draft with a resolved project cwd; write selection through `updateComposerDraftSettings`; retain it after transient request errors; clear it through the Task 4 compatibility effect.

- [ ] **Step 6: Run focused client tests**

Run: `vp test run apps/web/src/components/chat/OpenCodeSessionPicker.test.tsx apps/mobile/src/features/threads/OpenCodeSessionPicker.test.tsx`

Expected: both platforms cover source selection, retryability, clearing, and immutability.

### Task 6: Update User Guidance And Execute Targeted Regression Checks

**Files:**

- Modify: `docs/user/providers-opencode.md`
- Modify: any tests whose OpenCode expectations assert rollback, compaction, or fork behavior, primarily `apps/server/src/provider/Layers/OpenCodeAdapter.test.ts`

**Interfaces:**

- Consumes final behavior from Tasks 1-5.
- Produces user-facing guidance that OpenCode owns context and that session selection is available only before the first prompt.

- [ ] **Step 1: Add concise provider documentation**

Add a **Sessions** section after the server setup section:

```md
## Sessions

Before the first prompt in a new OpenCode thread, choose **New OpenCode session**
or select a previous session for the same project. T3 Code shows the selected
session's earlier transcript, but OpenCode keeps and uses the conversation
context. A thread cannot switch sessions after its first prompt.
```

Revise approvals wording to state that T3 Code applies its selected permission mode while OpenCode remains the authority that receives and persists approval replies.

- [ ] **Step 2: Replace obsolete context-management expectations**

Remove tests and user copy that claim OpenCode threads can use T3-native rollback or manual context compaction. Keep generic unsupported-provider UI coverage rather than deleting the user-facing disabled state.

- [ ] **Step 3: Run all focused touched tests**

Run: `vp test run packages/contracts/src/provider.test.ts packages/contracts/src/orchestration.test.ts apps/server/src/provider/opencodeRuntime.cliParsers.test.ts apps/server/src/provider/Layers/OpenCodeAdapter.test.ts apps/server/src/provider/opencodeRuntime.permissions.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts apps/web/src/components/chat/OpenCodeSessionPicker.test.tsx apps/mobile/src/features/threads/OpenCodeSessionPicker.test.tsx`

Expected: all targeted tests pass. If a listed test file was consolidated into an existing suite during implementation, run that suite instead and record the replacement in the pull request.

- [ ] **Step 4: Run targeted typechecks for changed packages**

Run: `vp --filter @t3tools/contracts typecheck && vp --filter t3 typecheck && vp --filter @t3tools/web typecheck && vp --filter @t3tools/mobile typecheck`

Expected: changed package typechecks pass without running repository-wide checks.

## Plan Self-Review

**Spec coverage:** Tasks 1-2 cover typed contracts, discovery, directory filtering, bounded ordering, and retryable discovery. Tasks 3-4 cover exact adoption, one-time display import, resume persistence, passive adapter boundaries, permission modes, explicit failure behavior, and first-prompt-only routing. Task 5 covers web/mobile UI states and immutability. Task 6 covers documentation and targeted regression verification.

**Placeholder scan:** The plan contains no deferred implementation markers. Commands that depend on a test file created in an earlier task name that exact created file.

**Type consistency:** `OpenCodeSessionSource` is defined in Task 1, transported by `ThreadTurnStartCommand`, persisted in client drafts in Task 4, and consumed by `ProviderSessionStartInput` in Task 3. `OpenCodeSessionListEntry` is defined in Task 1, returned by Task 2's RPC, and consumed by Task 5's picker.

## Post-Implementation Evidence

The implementation was audited against the reported new-session failures before
this plan was committed as evidence:

- The local OpenCode server process now receives `cwd: input.directory` in
  `apps/server/src/provider/opencodeRuntime.ts`. SDK directory routing remains
  explicit as a separate request-level contract.
- Client reconciliation is limited to server OpenCode threads with a usable
  lifecycle state. The adapter defers while connecting, starting a turn,
  admitting a prompt, or waiting on permissions/questions. A successful
  recovery retries the reconciliation key; a deferred result does not consume
  the one-shot key.
- `thread.history.replace` rejects an empty reconciliation while a new provider
  session is starting, preserving the initial user prompt. The corresponding
  invariant is covered by `apps/server/src/orchestration/decider.import.test.ts`.
- First-send failures remain visible through the server thread error state and
  the ChatView error banner rather than being treated as a successful silent
  promotion. The draft flow retains retryable state.
- OpenCode session age is derived from the latest user prompt. Usage export is
  opt-in through the existing usage request's `includeOpenCode` flag and scans
  discoverable sessions in each enabled OpenCode instance's current process
  directory, deduplicating session IDs within a scan. It does not yet restrict
  exports to a T3-tracked passive-session registry or separately track child
  sessions.

The focused tests for contracts, OpenCode runtime/adapter behavior, usage,
orchestration, and client state passed during implementation. The repository
test command also exposed one unrelated failure in the untouched
`scripts/build-desktop-artifact.test.ts` test under Node `24.12.0` (299 passed,
1 failed). Real two-project end-to-end verification of `pandas` versus
`warp-studio-windows`, including a live filesystem command and reconnect, was
not performed; those remain follow-up acceptance checks rather than completed
claims.
