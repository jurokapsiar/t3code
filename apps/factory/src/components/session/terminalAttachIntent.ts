export interface TerminalAttachIntent {
  readonly identity: string;
  readonly requested: boolean;
}

export function isTerminalAttachRequested(intent: TerminalAttachIntent): boolean {
  return intent.requested;
}

export function terminalAttachIdentity(
  targetIdentity: string,
  terminalId: string,
  sourceSessionId: number | undefined,
) {
  return JSON.stringify([targetIdentity, terminalId, sourceSessionId]);
}

export function createTerminalAttachIntent(identity: string): TerminalAttachIntent {
  return { identity, requested: false };
}

export function syncTerminalAttachIntent(
  intent: TerminalAttachIntent,
  identity: string,
): TerminalAttachIntent {
  return intent.identity === identity ? intent : { identity, requested: false };
}

export function toggleTerminalAttachIntent(
  intent: TerminalAttachIntent,
  identity: string,
): TerminalAttachIntent {
  const current = syncTerminalAttachIntent(intent, identity);
  return { ...current, requested: !current.requested };
}
