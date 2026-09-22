import type {
  EnvironmentId,
  OpenCodeSessionListEntry,
  OpenCodeSessionSource,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { openCodeEnvironment } from "../../state/opencode";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const DAY_MS = 24 * 60 * 60 * 1000;

export function formatOpenCodeSessionAge(lastPromptAt: string, now = Date.now()): string {
  const timestamp = Date.parse(lastPromptAt);
  if (Number.isNaN(timestamp)) return "";
  return `${Math.max(0, Math.floor((now - timestamp) / DAY_MS))}d`;
}

function sessionLabel(session: OpenCodeSessionListEntry): string {
  const title = session.title?.trim() || session.id;
  return session.lastPromptAt
    ? `${title} (${formatOpenCodeSessionAge(session.lastPromptAt)})`
    : title;
}

export function OpenCodeSessionPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string | null;
  readonly source: OpenCodeSessionSource | undefined;
  readonly editable: boolean;
  readonly onSourceChange: (source: OpenCodeSessionSource | undefined) => void;
}) {
  const query = useEnvironmentQuery(
    props.cwd === null || !props.editable
      ? null
      : openCodeEnvironment.sessions({
          environmentId: props.environmentId,
          input: { instanceId: props.instanceId, cwd: props.cwd },
        }),
  );
  const [search, setSearch] = useState("");
  const selectedValue = props.source?.type === "existing" ? props.source.sessionId : "new";
  const sessions = query.data?.sessions ?? [];
  const filteredSessions = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return needle.length === 0
      ? sessions
      : sessions.filter((session) =>
          [session.title, session.id].some((value) => value?.toLocaleLowerCase().includes(needle)),
        );
  }, [search, sessions]);
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedValue),
    [selectedValue, sessions],
  );

  if (!props.editable) {
    return (
      <span className="max-w-48 truncate text-xs text-secondary-label" title={selectedSession?.id}>
        {selectedSession ? `OpenCode: ${sessionLabel(selectedSession)}` : "OpenCode session"}
      </span>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Select
        value={selectedValue}
        onValueChange={(value) => {
          if (value === null) return;
          props.onSourceChange(
            value === "new" ? { type: "new" } : { type: "existing", sessionId: value },
          );
        }}
      >
        <SelectTrigger
          aria-label="OpenCode session"
          size="sm"
          variant="ghost"
          className="min-w-0 max-w-52 text-secondary-label"
        >
          <SelectValue placeholder="New OpenCode session" />
        </SelectTrigger>
        <SelectPopup>
          <Input
            aria-label="Search OpenCode sessions"
            className="mb-2"
            placeholder="Search sessions"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <SelectItem value="new">New OpenCode session</SelectItem>
          {filteredSessions.map((session) => (
            <SelectItem key={session.id} value={session.id}>
              {sessionLabel(session)}
            </SelectItem>
          ))}
          {filteredSessions.length === 0 && !query.isPending ? (
            <div className="px-2 py-1.5 text-xs text-secondary-label">
              {query.error
                ? "Could not load previous sessions"
                : "No previous sessions for this directory"}
            </div>
          ) : null}
        </SelectPopup>
      </Select>
      {query.error ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Retry loading OpenCode sessions"
          onClick={query.refresh}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
