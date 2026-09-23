# OpenCode Passive Sessions

## Goal

Make the OpenCode provider a passive client of OpenCode-owned conversations. Before
the first prompt, a user can either create a new OpenCode session or attach the
new T3 Code thread to an existing OpenCode session for the selected project
directory. OpenCode, not T3 Code, owns all prompt context, compaction, ancestry,
and session history.

This applies to web and mobile. Desktop receives the web behavior.

## Implementation Record

This design was implemented in commit `f7492bb43abd68dc44dc4a00cfda1a33a5910678`.
The shipped implementation additionally starts local OpenCode processes with
the selected project directory as their cwd, defers reconciliation during
startup and prompt-admission states, and rejects history replacement while a
new session is starting. These safeguards prevent an initial prompt from being
lost or rooted in the T3 server's launch directory.

## Scope

- Add a pre-first-prompt OpenCode session source: `new` or a specific upstream
  OpenCode session ID.
- List only sessions whose normalized directory matches the selected project
  directory.
- Import the selected upstream session transcript once for display in the T3
  thread, without using it to construct subsequent prompts.
- Persist the upstream ID when an existing session is selected, and persist a
  newly created ID once the first prompt has successfully established it.
- Retain T3 Code runtime permission modes and translate approval responses to
  OpenCode-supported replies.
- Remove T3 Code's OpenCode-specific context-management operations.

## Non-goals

- Selecting or changing an OpenCode session after the thread's first prompt.
- Showing OpenCode sessions from a different directory.
- Writing imported transcript content back to OpenCode.
- Replacing OpenCode's native session context, compaction, titles, or ancestry.
- Adding a separate thread-creation workflow solely for OpenCode sessions.

## Client Experience

When an untouched draft thread selects an OpenCode provider instance, its composer
configuration shows a Session control beside the existing OpenCode choices. The
default is New OpenCode session. A picker lists matching upstream sessions with
their title, recency, and available model or agent metadata. It supports search
and refresh.

The selection is part of the normal draft-thread configuration. It is available
from every route that creates a draft thread, including regular new-thread entry
points, command palette entry points, and keyboard shortcuts. Mobile exposes the
same choice through its thread settings/draft configuration surface.

Changing the provider away from OpenCode, changing the provider instance, or
changing the project directory clears an incompatible selection. After a first
prompt has been sent, the source is fixed and appears as non-editable session
metadata. T3 Code must not offer a session-switch action for an existing thread.

## Contracts And Discovery

Add typed requests and responses for listing OpenCode sessions by normalized
project directory, and for storing a draft thread's OpenCode session source. A
list entry contains only picker metadata: upstream session ID, title, directory,
timestamps, and model or agent metadata when OpenCode provides it.

The server uses the supported OpenCode session-list CLI/API path in the project
directory. It normalizes and canonically compares directories before returning a
bounded, newest-first result set. Session discovery does not start or mutate an
upstream session.

A discovery failure leaves New OpenCode session available. The client renders a
retryable non-blocking error rather than preventing a user from starting a new
OpenCode conversation.

## Provider Behavior

On the first prompt, a New OpenCode session source creates exactly one upstream
session. The adapter persists its ID in the resume cursor after successful
creation or prompt admission.

For an existing source, the adapter checks that the upstream ID still exists and
matches the canonical project directory. It adopts that exact ID. Before sending
the first prompt, it fetches the upstream messages once and projects them into
the T3 thread for display. This import is read-only: it never becomes a synthetic
prompt, a resume payload, or input to a T3-owned context builder. Live OpenCode
events append to that imported display transcript.

OpenCode remains authoritative for context accumulation, native compaction,
session titles, session ancestry, and session lifecycle. T3 Code sends only the
new prompt, attachments, selected model or agent, and the active runtime
permission mode.

The adapter must not silently replace an unavailable or mismatched selected
session with a new session. A missing session or directory mismatch blocks the
first send and requires the user to select a valid session or choose New OpenCode
session. Connection, authentication, and transient server errors retain the
selection and allow retry.

## Removed Context Management

OpenCode no longer advertises native compaction or conversation rollback. Remove
OpenCode paths that call `session.fork`, `session.summarize`, or reconstruct a
provider snapshot to support a rollback. Set the adapter's
`supportsConversationRollback` capability to false so existing client controls
use their unsupported-provider state.

Read-only transcript import is the only historical message read required by this
feature. It is not context reconstruction.

## Permissions And Approvals

T3 Code continues to apply its selected runtime permission mode to new and
adopted OpenCode sessions. Existing OpenCode permission events remain the source
of approval UI. T3 Code translates responses only into replies OpenCode supports:
one-time allow, persistent workspace/session allow where OpenCode accepts it,
reject, and cancel. No approval response may imply a persistence scope broader
than OpenCode provides.

## Errors

- Session-list errors are retryable and do not block New OpenCode session.
- Missing selected sessions and directory mismatches block the first prompt with
  an actionable source-selection error.
- Transcript-import, authentication, and connectivity failures surface the
  provider error, preserve the chosen source, and permit retry.
- No error path forks, creates, or adopts a different upstream session without
  the user's explicit selection.

The first-send draft/promotion path preserves the server thread error and shows
it in the ChatView error banner, so a provider startup failure is retryable and
not indistinguishable from a missing sidebar thread.

## Testing

- Contracts and server tests cover directory filtering, result ordering and
  bounds, selection persistence, and discovery failures.
- Adapter tests cover new-session creation, exact-session adoption, one-time
  transcript import, ID persistence, missing-session and directory-mismatch
  failures, retryable transport errors, and the absence of fallback creation.
- Adapter tests assert that passive mode does not call `session.fork`,
  `session.summarize`, rollback/history-rebuild paths, or synthetic continuation
  paths. Existing permission-rule and approval-reply tests remain and expand for
  adopted sessions.
- Web and mobile tests cover the default source, picker result/error/refresh
  states, compatibility clearing, and post-first-prompt immutability.
- Update the OpenCode user guide with session selection, OpenCode context
  ownership, and approval behavior.
