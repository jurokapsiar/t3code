import type { FactoryFrameTarget } from "@t3tools/contracts/factory";
import { frameTargetKey } from "../../factory/queryKeys";

interface DraftSnapshot {
  readonly prompt: string;
  readonly error: string | undefined;
}
interface DraftSubmission {
  readonly owner: SessionDraft;
  readonly revision: number;
}
export function sessionDraftKey(factoryId: string, target: FactoryFrameTarget): string {
  return JSON.stringify([factoryId, frameTargetKey(target)]);
}

export class SessionDraft {
  private value: DraftSnapshot = { prompt: "", error: undefined };
  private revision = 0;
  private active = true;
  private readonly listeners = new Set<() => void>();
  constructor(readonly identity: string) {}
  readonly snapshot = () => this.value;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  activate() {
    this.active = true;
  }
  deactivate() {
    this.active = false;
  }
  isActive() {
    return this.active;
  }
  edit(prompt: string) {
    this.revision += 1;
    this.update({ ...this.value, prompt });
  }
  begin(): DraftSubmission {
    this.revision += 1;
    this.update({ ...this.value, error: undefined });
    return { owner: this, revision: this.revision };
  }
  succeed(submission: DraftSubmission): boolean {
    if (!this.owns(submission)) return false;
    this.edit("");
    return true;
  }
  fail(submission: DraftSubmission, error: string): boolean {
    if (!this.owns(submission)) return false;
    this.update({ ...this.value, error });
    return true;
  }
  private owns(submission: DraftSubmission) {
    return this.active && submission.owner === this && submission.revision === this.revision;
  }
  private update(value: DraftSnapshot) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}
