# OpenCode

Install and authenticate OpenCode on the machine running your environment, then
enable it in **Settings > Providers**. See [provider setup](./install.md#providers).
T3 Code requires OpenCode 1.14.19 or newer, including when you connect an existing
OpenCode server.

## Local or external server

Leave **Server URL** empty to let T3 Code start OpenCode locally. A password in
provider settings applies to both that server and T3 Code's connection. With no
password setting, the local server uses `OPENCODE_SERVER_PASSWORD` from its
environment.

To use an existing OpenCode server, set **Server URL** and its password in provider
settings. T3 Code uses only that configured password for an external server; it
does not forward a local `OPENCODE_SERVER_PASSWORD`. If connection or version checks
fail, check the URL, credentials, and OpenCode version, then refresh provider status.

When you open an existing OpenCode thread, T3 Code checks the event stream and
reconnects the same session when needed. It also refreshes the displayed history
from OpenCode and replaces stale T3 history without replaying it as a prompt.
After a lost connection, reopening the thread retries the same reconciliation.

## Sessions

Before the first prompt in a new OpenCode thread, choose **New OpenCode session**
or select a previous session for the same project directory. T3 Code shows the
selected session's earlier transcript for reference, while OpenCode keeps and
uses the conversation context. A thread cannot switch sessions after its first
prompt. Missing or moved sessions must be reselected; T3 Code will not silently
fork or replace the selected session.

OpenCode is the source of truth for session history. If the session was changed
outside T3 Code, the next thread-open reconciliation updates the T3 display to
match OpenCode.

## Approvals

OpenCode follows the shared [permission modes](./permission-modes.md). **Auto** has
the same rules as **Supervised** because OpenCode has no AI approval reviewer.
Environment files such as `.env` and `.env.local` need approval in restricted
modes even though normal file reads do not; `.env.example` is allowed.

**Allow for workspace** applies to matching requests in other OpenCode sessions
using the same workspace. It is broader than the current thread, especially on a
shared external server. Use **Allow once** for a single request. Denying an action
does not stop the whole turn. T3 Code applies the selected permission mode, while
OpenCode remains the authority that receives and stores approval replies.

OpenCode owns its conversation context and native compaction. T3 Code does not
rebuild OpenCode history or provide conversation rollback for OpenCode threads.

## Refresh models, commands, and skills

After changing an OpenCode login or configuration, use **Refresh provider status**
in **Settings > Providers** for that environment. On mobile, use **Refresh models**
in the thread settings. Reconnecting also refreshes the catalog; periodic provider
health checks do not.

Credential changes are read on refresh. Native OpenCode configuration can remain
cached while the local helper is running. Let it sit for 30 seconds without model
refreshes or text-generation work, then refresh again to reload the files. Repeated
refreshes keep the helper alive. An external server may need its own reload or
restart before T3 Code can see configuration changes.

Existing threads keep their selected model and options even when it disappears
from the catalog. If OpenCode rejects that model, select an available one and retry.
