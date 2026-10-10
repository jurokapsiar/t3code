import * as Schema from "effect/Schema";
import { FactoryFrameTarget } from "@t3tools/contracts/factory";
import { describe, expect, it } from "vite-plus/test";
import { SourceActionRegistry } from "../../factory/actionPolicy";
import { SessionDraft, sessionDraftKey } from "./sessionDraft";

const target = Schema.decodeUnknownSync(FactoryFrameTarget)({
  registrationId: "registration-a",
  environmentId: "environment-a",
  threadId: "thread-a",
});
describe("SessionDraft completion ownership", () => {
  it("keeps full Factory/registration/environment/thread draft identities distinct", () => {
    const identity = sessionDraftKey("factory-a", target);
    for (const key of ["registrationId", "environmentId", "threadId"]) {
      expect(
        sessionDraftKey(
          "factory-a",
          Schema.decodeUnknownSync(FactoryFrameTarget)({ ...target, [key]: "other" }),
        ),
      ).not.toBe(identity);
    }
    expect(sessionDraftKey("factory-b", target)).not.toBe(identity);
  });
  it("does not move A text or late success/error into B, or clear a newer same-target draft", () => {
    const a = new SessionDraft(sessionDraftKey("factory-a", target));
    a.edit("A prompt");
    const sentA = a.begin();
    const b = new SessionDraft(
      sessionDraftKey(
        "factory-a",
        Schema.decodeUnknownSync(FactoryFrameTarget)({ ...target, threadId: "thread-b" }),
      ),
    );
    expect(b.snapshot().prompt).toBe("");
    b.edit("B prompt");
    expect(b.succeed(sentA)).toBe(false);
    expect(b.fail(sentA, "A failed")).toBe(false);
    expect(b.snapshot()).toEqual({ prompt: "B prompt", error: undefined });
    a.deactivate();
    expect(a.fail(sentA, "Late A failed")).toBe(false);
    const sentB = b.begin();
    b.edit("New B prompt");
    expect(b.succeed(sentB)).toBe(false);
    expect(b.fail(sentB, "Old B failed")).toBe(false);
    expect(b.snapshot()).toEqual({ prompt: "New B prompt", error: undefined });
    const latest = b.begin();
    expect(b.fail(latest, "Rejected")).toBe(true);
    expect(b.snapshot().error).toBe("Rejected");
    const retry = b.begin();
    expect(b.snapshot().error).toBeUndefined();
    expect(b.succeed(retry)).toBe(true);
    expect(b.snapshot().prompt).toBe("");
  });
  it("preserves B draft and connection-owned uncertainty while A completes asynchronously", async () => {
    const actions = new SourceActionRegistry();
    const a = new SessionDraft(sessionDraftKey("factory-a", target));
    a.edit("A prompt");
    const submission = a.begin();
    let resolve!: () => void;
    const response = new Promise<void>((done) => {
      resolve = done;
    });
    const scope = {
      type: "thread",
      factoryId: "factory-a",
      environmentId: target.environmentId,
      threadId: target.threadId,
    } as const;
    const pending = actions
      .dispatch({
        scope,
        commandId: "A-command",
        intent: { kind: "prompt", messageId: "A-message" },
        baseSequence: 1,
        state: { online: true, synchronized: true, allowed: true },
        request: () => response,
      })
      .then(() => a.succeed(submission));
    a.deactivate();
    const b = new SessionDraft(
      sessionDraftKey(
        "factory-a",
        Schema.decodeUnknownSync(FactoryFrameTarget)({ ...target, threadId: "thread-b" }),
      ),
    );
    b.edit("B prompt");
    resolve();
    expect(await pending).toBe(false);
    expect(b.snapshot().prompt).toBe("B prompt");
    const uncertainScope = { ...scope, threadId: "uncertain-thread" };
    await expect(
      actions.dispatch({
        scope: uncertainScope,
        commandId: "uncertain-command",
        intent: { kind: "prompt", messageId: "uncertain-message" },
        baseSequence: 1,
        state: { online: true, synchronized: true, allowed: true },
        request: async () => {
          throw new Error("Transport ended");
        },
      }),
    ).rejects.toMatchObject({ name: "SourceCommandUncertainError" });
    b.deactivate();
    expect(actions.blocking(uncertainScope)?.phase).toBe("uncertain");
    let replayed = false;
    await expect(
      actions.dispatch({
        scope: uncertainScope,
        commandId: "replacement-id",
        intent: { kind: "prompt", messageId: "replacement-message" },
        baseSequence: 1,
        state: { online: true, synchronized: true, allowed: true },
        request: async () => {
          replayed = true;
        },
      }),
    ).rejects.toThrow("uncertain");
    expect(replayed).toBe(false);
  });
});
