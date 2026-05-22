# Multi-chat architecture

How the chat drawer supports up to 3 concurrent agent conversations,
each with isolated state, scoped permission prompts, and aggregated
status reporting.

## What the user sees

The bottom drawer is a tabbed surface:

```
┌────────────────────────────────────────────────────────────────────┐
│  ● lido-eth-api/chat   × │ ● my-vault/04-th…  × │ ● New chat × │ + │
├────────────────────────────────────────────────────────────────────┤
│  CHAT  [History]  running · lido-eth-api/chat        147K in · Stop│
│  ─────────────────────────────────────────────────────────────────│
│  ▶ start claude-code · lido-eth-api/chat · cwd: /…                 │
│  ◆ system: init · model=claude-opus-4-7                            │
│  ⚠ Permission: Claude wants to use Bash       [Deny][Allow once]…  │
│  ─────────────────────────────────────────────────────────────────│
│  SCOPE: lido-eth-api (repo)        ▸ Send · disabled while running │
└────────────────────────────────────────────────────────────────────┘
```

- Each tab chip shows a state dot (idle / running / exited /
  stopping), the chat title, a `!` badge when waiting on a permission,
  and a close button (when ≥2 tabs exist).
- "+" opens a new empty tab; the active tab stays where it is.
- Inactive tabs stay **mounted-but-hidden** (`display: none`) so their
  output buffer, session id, and event listener survive switches.
- The permission card is rendered inline above the textarea inside its
  own chat — no global modal that could be ambiguous about which run
  needs the user's attention.

## Layer map

```
┌──────────────────────────────────────────────────────────────────┐
│  Dashboard.tsx                                                   │
│    runPanelRef: RunPanelHandle  ← used for stagePrompt, reopen,  │
│                                    subscribeToStatus, toggle     │
└──────────────┬───────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────┐
│  RunPanelHost.tsx                                                │
│    chats: ChatTabRecord[]                                        │
│    activeChatId: ChatId                                          │
│    tabStatus: Map<ChatId, ChatTabStatusInfo>                     │
│    handlesRef: Map<ChatId, RunPanelHandle>  ← per-tab handles    │
│                                                                  │
│    Mount-sync: getRuns() once → one tab per live backend run     │
│    Tab bar UI (chips + "+" + close)                              │
│    Status aggregation: derives vault-wide RunStatusInfo from     │
│      tabStatus and re-broadcasts to subscribers                  │
│    Imperative handle: delegates to active tab; reopenSession     │
│      creates a new tab; stagePrompt falls back to new tab if     │
│      active is running                                           │
└──────────────┬───────────────────────────────────────────────────┘
               │ renders N panels, only one visible
┌──────────────▼───────────────────────────────────────────────────┐
│  RunPanel.tsx — one per chat tab                                 │
│    Local state: status, lines, sessionId, currentRunId,          │
│      chatDraft, selectedScope, stagedSource, pendingTitle,       │
│      startedAtMs, pendingPermission, usage, collapsed            │
│    Subscribes to onRunEvents() — every callback gates on         │
│      isMine(ev.runId) === currentRunIdRef.current                │
│    Publishes ChatTabStatusInfo via onStatusChange prop           │
│    Renders PermissionRequestCard inline above the textarea       │
└──────────────┬───────────────────────────────────────────────────┘
               │ Tauri commands (invoke + listen)
┌──────────────▼───────────────────────────────────────────────────┐
│  apps/desktop/src-tauri/src/lib.rs                               │
│    RunState { next_gen, runs: HashMap<RunId, ActiveRun> }        │
│    MAX_CONCURRENT_RUNS = 3                                       │
│    mint_run_id(gen) → "r-{gen}-{unix_ms}"                        │
│                                                                  │
│    spawn_and_pump → Result<RunStartedPayload>                    │
│      - Atomic lock + cap check + insert into `runs`              │
│      - Emit thread captured runId; every event carries runId     │
│      - On RunEvent::Exit → removes runs[runId] (gen-checked)     │
└──────────────────────────────────────────────────────────────────┘
```

## The `runId` discriminator

Every run is identified by a string minted at spawn time:

```
r-{gen}-{epoch_ms}
```

- `gen` is `RunState.next_gen` (wrapping `u64`), incremented per spawn.
  Survives the legacy "stop+restart fast" race-guard role from the
  pre-multi-chat era.
- `epoch_ms` makes the id unique across process restarts so logs can
  be correlated.

The id is:

1. **Returned** from the spawn-command invoke (`start_run` and friends
   now resolve with the full `RunStartedPayload`, not just the id).
   This is the **source of truth** for the frontend — by the time the
   `await` resolves, the panel knows its run id and can flip its
   `currentRunIdRef` synchronously.
2. **Emitted** on every event (`run:started`, `run:stdout`,
   `run:stderr`, `run:truncated`, `run:permission-request`,
   `run:exit`). The frontend filters with
   `isMine(ev.runId) === currentRunIdRef.current === ev.runId` to
   route each event to the correct panel.
3. **Required** by `stop_run(runId)`, `approve_tool_use(runId, …)`,
   `deny_tool_use(runId, …)` so a tab can only act on its own run.

## The race fix — why spawn-commands return the payload

Tauri's `listen()` events and `invoke()` responses use separate
channels with no guaranteed ordering. In the multi-chat refactor an
earlier design relied on the `run:started` event to flip the panel's
status to `running` — but if the event fired _before_ the invoke
promise resolved, the panel's strict `isMine` filter rejected it
(`currentRunIdRef` was still `null`), and the status stayed `idle`
forever even though the backend was streaming.

The fix is to thread the full `RunStartedPayload` back through the
invoke return so the panel can adopt the run **synchronously** from
the resolved value:

```typescript
const started = await startFreeformRun({…});  // returns RunStartedEvent
adoptStarted(started);   // sets currentRunIdRef + status = running
```

The async `run:started` event still fires later (or earlier, no
guarantee) but the listener handler is now an idempotent confirmation:
its `isMine` filter passes against the already-set ref, and
re-applying the same state is a React no-op.

Stream events (`stdout`, `exit`, …) don't suffer the race because
subprocess output latency (≥100 ms) dwarfs the IPC trip — by the
time claude writes its first JSON line the invoke has resolved.

## How a chat starts (sequence)

```
User clicks Send in tab A
        │
        ▼
RunPanel.onSend (tab A)
        │
        ├─ appendLine({kind: "user", text})  ← echo before invoke
        │
        ▼
invoke("start_freeform_run", {…})
        │
        ├─────────────────────────► Tauri shell
        │                                │
        │                                ▼
        │                        spawn_and_pump
        │                          ├─ lock RunState
        │                          ├─ check runs.len() < 3
        │                          ├─ mint_run_id(gen)
        │                          ├─ ClaudeRunner::start
        │                          ├─ insert ActiveRun
        │                          ├─ app.emit("run:started", payload.clone())
        │                          └─ thread::spawn(emit pump)
        │                                │
        │                          returns Ok(payload)
        │                                │
        ◄────── invoke resolves ─────────┘
        │
        ▼
adoptStarted(payload) — synchronous:
  ├─ currentRunIdRef.current = runId
  ├─ setStatus({kind: "running", started: payload})
  ├─ setSessionId(null), setUsage(EMPTY_USAGE)
  ├─ setStartedAtMs(Date.now())
  └─ setCollapsed(false)
        │
        ▼
[Meanwhile, asynchronously delivered:]
  - run:started event arrives. isMine === true (ref set).
    Handler re-applies same state — React dedupes (no-op).
  - run:stdout events arrive as claude streams.
    Handler parses, accumulates usage, appends lines.
  - run:permission-request fires when claude pauses for a tool.
    Handler sets pendingPermission → inline card renders.
  - run:exit fires when subprocess terminates.
    Handler flips status to "exited", clears currentRunIdRef.
```

## How a sibling tab stays out of the way

When tab A's run streams stdout, every other RunPanel's listener also
receives the event (Tauri broadcasts to all `listen()`s). The
filtering keeps them quiet:

```typescript
onStdout: (ev) => {
  if (!isMine(ev.runId)) return;  // ← ev.runId is A's, but B's ref is null or different
  …
}
```

The same strict gate applies to `onStarted` — when tab A's spawn fires
`run:started{runId: X}`, tab B's `isMine(X)` returns false because
tab B's `currentRunIdRef.current` is its own run id (or `null`). Tab
B ignores. Without this strict gate the original pre-fix code
unconditionally adopted started events, which would have caused
sibling tabs to clobber each other's run ids in multi-chat scenarios.

## Inline permission card vs. the old modal

Pre-multi-chat, a single global `ApproveToolsModal` lived on
Dashboard and was driven by a Dashboard-level `pendingPermission`
state populated from a duplicate `onRunEvents` subscription. With one
chat that worked; with two chats both pausing on permissions, the
modal had no way to indicate which chat needed the user's attention,
and approve/deny had no run-id binding (it called whatever was in the
single backend slot).

Now:

- `PermissionRequestCard` renders **inside** the chat that paused, in
  the same column as the output buffer (right above the textarea so
  it's visible regardless of `showChatInput`).
- The pending state lives on `RunPanel.pendingPermission`, gated by
  the same `isMine(runId)` filter as stream events.
- `approve_tool_use` / `deny_tool_use` take `runId` + `requestId`,
  routing the typed decision via
  `RunState.runs[runId].killer.respond_to_permission(request_id,
  decision)`. The runner's pump task correlates `request_id` against
  its in-flight permission map and fulfils the agent's pending
  `session/request_permission` RPC over ACP.
- Closing a tab with a pending permission is safe — the runner's
  pending map drops together with its worker thread, and the
  agent's RPC future gets dropped on disconnect (codex-acp /
  claude-agent-acp both clean up the paused turn).

## Status aggregation (AI handle / StatusBar)

The TitleBar AI handle (`● 2 live`) and StatusBar
(`2 chats running · 8 total`) consume a single vault-wide
`RunStatusInfo`. The host derives it from every tab's most-recent
`ChatTabStatusInfo`:

| Aggregate field    | Rule                                            |
|--------------------|-------------------------------------------------|
| `state`            | `"running"` if any tab is running/stopping; else `"exited"` if any exited; else `"idle"` |
| `runningCount`     | Count of tabs in `running` or `stopping`        |
| `runningSkill`     | First running tab's skill (representative)      |
| `runningProject`   | First running tab's project (representative)    |
| `lastUsage`        | **Sum** of tokens + cost across all tabs        |
| `savedCount`       | **Max** of per-tab counts (each tab observes the same vault-wide DB; max ignores tabs that haven't fetched yet) |

This means: starting a chat in a background tab still pulses the AI
handle dot, and total spend across all conversations is visible at a
glance.

## Visibility and the scroll-position quirk

Inactive tabs use `display: none` on the `<aside>`, not unmount. This
keeps event listeners attached and `lines`/`usage` updating in the
background.

One subtle side effect: while hidden, `el.scrollHeight === 0` on the
output `<pre>`. The follow-tail effect that auto-scrolls to the
bottom on new lines therefore writes `scrollTop = 0` on every update.
When the user comes back, the element regains its real height but
the scroll position is stuck at the top — looking like "logs
stopped".

Fix: an additional effect re-snaps to the bottom when `visible`
flips back to `true`, but only when the user hasn't manually
scrolled up (`followTail.current === true`).

## Lifecycle quick reference

| Trigger                          | Effect                                                        |
|----------------------------------|---------------------------------------------------------------|
| Click "+"                        | Host: addChat → new tab with `initialCollapsed=false`         |
| Click tab chip                   | Host: setActiveChatId → CSS visibility flip                   |
| Click × on tab                   | Host: closeChat → remove from list; pick neighbour as active; always keep ≥1 tab |
| History row "Reopen"             | Host: new tab with `initialState={kind:"reopen", session}` → ChatTab's mount effect calls `reopenSession` |
| External "Open in chat"          | Host: stagePrompt → active tab if idle/exited; else new tab; rAF-dispatches stagePrompt to it |
| New chat (panel header)          | RunPanel: `onNewChat` — resets THIS tab's state (does NOT add a tab) |
| Reply (in exited state)          | RunPanel: `resumeRun` / `resumeFreeformRun` → new runId, same claudeSessionId |
| Stop                             | RunPanel: `stopRun({runId: startedSnapshot.runId})` — kills only this tab's subprocess |
| App restart / HMR mid-run        | Host: mount-sync via `getRuns()` → one tab per live backend run with `initialState={kind:"adopt", started}` |

## File map

| File                                              | Role                                                  |
|---------------------------------------------------|-------------------------------------------------------|
| `apps/desktop/src-tauri/src/lib.rs`               | `RunState`, command surface, emit pump, `mint_run_id` |
| `apps/desktop/src/api.ts`                         | Typed IPC wrappers; spawn fns return `RunStartedEvent`|
| `apps/desktop/src/components/RunPanelHost.tsx`    | Multi-chat host: tab bar, mount-sync, aggregation     |
| `apps/desktop/src/components/RunPanel.tsx`        | One chat tab: state, listener, output, permission card slot |
| `apps/desktop/src/components/PermissionRequestCard.tsx` | Inline permission UI inside a chat              |
| `apps/desktop/src/components/Dashboard.tsx`       | Hosts `RunPanelHost`; threads ref + handle methods    |
