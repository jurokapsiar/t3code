# OpenCode Session Telemetry

## Goal

Improve the OpenCode session selector and usage collection for passive OpenCode
sessions opened by T3 Code.

## Implementation Record

The implemented telemetry changes landed in commit
`f7492bb43abd68dc44dc4a00cfda1a33a5910678`. Session age is available in the
web picker and `opencode export` records flow through the existing usage
aggregation path.

## Scope

The session selector will show the age of each session since its most recent
user prompt in compact parenthesized form, for example `Title (15d)`. OpenCode
usage telemetry will be collected for every passive session ID that T3 opens or
adopts, including related child sessions.

## Session Age

Extend `OpenCodeSessionListEntry` with `lastPromptAt` when a user message is
available. Derive it from the latest user message rather than using
`updatedAt`, because OpenCode can update session metadata without receiving a
prompt.

The web selector will render:

- `Title (0d)` for a session prompted today
- `Title (15d)` for a session last prompted fifteen days ago
- The session ID in place of a missing title

Age is calculated as elapsed calendar days in the client’s local timezone. A
session without a user prompt keeps its existing title/ID label without an age
suffix.

## Telemetry Collection

T3 uses the existing OpenCode CLI runtime when the usage request opts into
OpenCode collection (the global `/usage` cost view sets this flag):

```bash
opencode export <session_id>
```

The export is an authoritative snapshot for a discovered OpenCode session. T3
does not export during normal session selection or prompting. The current
implementation lists sessions for each enabled OpenCode instance in the
process cwd and exports each unique session ID in that scan. It does not yet
maintain a T3-owned passive-session registry or separately track related child
sessions.
The command will inherit the same binary path, working directory, environment,
configuration, and authentication setup as the OpenCode server process.

The export parser will validate and extract:

- Session title
- Model
- Context token usage
- Input, cached-input, cache-creation, output, and reasoning token counts when
  present
- Provider-reported cost
- Session metadata

Export failures are non-fatal. Chat operation continues, and the telemetry
remains unavailable until a later refresh succeeds.

## Usage Integration

OpenCode will be added to the existing provider usage collection path rather
than introducing a separate usage system. Export records will flow through the
existing pricing and aggregation logic, preserving cost-source handling,
time-window filtering, and session counts.

Repeated exports must not double-count usage. Records will use a stable
OpenCode session/message or export revision identity for deduplication.

Live OpenCode turn usage remains available for the active session. Export
reconciliation supplies authoritative passive-session totals and finalized cost
information.

## Data Flow

1. T3 lists OpenCode sessions for the current directory.
2. The server loads the OpenCode `session.messages` response and derives
   `lastPromptAt` from its latest user message.
3. The selector formats the title and compact age suffix.
4. T3 opens or adopts a passive session.
5. When the cost view is opened, the server lists sessions in the configured
   OpenCode process cwd and runs `opencode export` for each unique ID.
6. Valid export data becomes OpenCode usage records and session metadata.
7. The existing usage aggregator prices, deduplicates, and publishes the result.

## Testing

Add focused tests for:

- OpenCode export JSON parsing and malformed payload handling
- Token and cost extraction, including optional fields
- Stable export-record deduplication
- `lastPromptAt` derivation
- Compact `(Nd)` age formatting and missing-prompt behavior
- Passive-session open and post-prompt refresh; child-session tracking remains
  future work.
- Usage aggregation and pricing for OpenCode records

## Non-Goals

- Replacing the existing OpenCode SDK event stream for live chat
- Exposing API credentials or raw export payloads to logs
- Adding a separate OpenCode-only usage page
- Changing session titles or OpenCode’s persisted session data
