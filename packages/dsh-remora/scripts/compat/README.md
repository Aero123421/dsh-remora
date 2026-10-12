# Adapter compatibility check

`pnpm --filter dsh-remora test:compat` runs the Remora operation adapter
(`src/adapter`) against the **real DSH services** at the commit pinned in
`upstream.json` (0.2.1-alpha.2, `d743267`).

1. `upstream.mjs` fetches that commit into `.cache/upstream` (shallow git
   fetch; `DSH_UPSTREAM_DIR=<checkout>` uses a local checkout instead) and
   compiles `host-entry.ts` with esbuild. `@deepseek-ai/*` imports resolve to
   the package sources through the official `tsconfig.base.json` `paths`;
   third-party packages (`zod`, `mime-types`) come from this package's
   devDependencies. Nothing here ships in the plugin.
2. `run.mjs` composes a host from those services, wires the adapter to it with
   an in-memory task store and a scope that reaches one workspace, and runs the
   checks below. It exits non-zero on any failure.

## Real DSH code exercised

Cordis `Context`; `LlmRuntime`; `SessionStore`; `SessionProjectionRegistry`;
`SystemPrompt`; `ToolRuntime`; `AgentRegistry`; `AgentLoop` (the real turn
loop); `JsonlSessionPersistence` (real files in a temp dir);
`session-checkpoint-policy`; `SessionProjectionCache`; `Storage` +
`storage-json` + `StorageDomain`; `WorkspaceRegistry`; `session-turn-outline`;
`TokenMeter`; `SessionTitleService`; `UserQuestionService`; `tool-ask-user`
in **timed** mode (1 s); `ApprovalService` (`dsh-user-approval`, policy
`ask`); `SessionQueryEngine` (point reads and listings);
`SessionController` (list, inspect, projections, create, rename, prompt with
requestId dedupe, updateQueue, cancel, resolveAgent / resume).

## Checks

| Check | What it proves |
| --- | --- |
| task.start → new session | `session.create` with a deterministic id attaches to the workspace; the task record is stored before DSH sees the prompt; `requestId = remora:<clientId>:<taskId>` |
| completion | the real agent loop runs the turn; the watcher (subscribed to `session/event` / `api-session/status`) moves the task to `completed`; the reply is read back and redacted; DSH stored the requestId as `source.rpcId` |
| retry | a retried task.start, and a raw re-prompt with the same requestId, add no second user message |
| live reads | sessions.list (workspace, title), session.get (turn outline, queue), session.read page, session.usage (token-meter), attention.list |
| restart | after disposing the whole host and booting a new one on the same folders: the cold session is listed with its workspace and cached title, read at every depth and its finished task result rebuilt, **without** a live Agent appearing; task.start (target `latest`) then resumes it from JSONL and completes |
| timed question | the model calls `ask_user_question`; after the 1 s window the question is `continued`; the task goes `needs_attention` with an answerable item; an AttentionEvent without `detail` is emitted; attention.respond → `userQuestions.answer` steers the reply and the task completes with the follow-up turn's reply; a second answer is refused |
| blocking question | the model calls `ask_user_question` with `timeout: -1` (a blocking ask, as in the default legacy mode): Remora's answerer, first in the real `user-questions/request` chain, holds it (nothing else answers in this run, so with a deadline); attention.list shows it answerable from outside; attention.respond answers through the chain and the tool result carries the answer |
| approvals | during an open turn, `ctx.approval.request(...)` logs `approval/asked` and runs the real `approval/request` chain: Remora holds it (route `hub-passkey`), approval.respond resolves it `allowed-once` and DSH logs that outcome; a second request nobody answers comes back `unavailable` after the wait |
| resubmit / steer | resubmit re-sends the prompt read back from the log; steer on an idle session is queued |
| cancel | a prompt queued behind a running turn is removed through `session.updateQueue`; the running one is stopped through `session.cancel` |
| scope / archive | a workspace outside the scope is `denied`; an archived session (real `archiveSession`) is refused before DSH and hidden from sessions.list |

## Stand-ins (not real DSH code)

- The model is DSH's own scripted `MockAdapter` (`packages/core/agent-loop/tests/mock-adapter.ts`).
- `@deepseek-ai/node-addon-system/flock` is replaced by a no-op (`flock-shim.ts`): the prebuilt native addon is not installed and the run is one process.
- `typert`, `agentDefaultModel`, `attachments`, `fileUploads` and `fs` are minimal stubs, as in DSH's own session-controller test harness.
- Full-text session search is not composed (`CompatSessionQuery` rejects searches).

## Not covered

- Loading through the DSH plugin loader / `cordis.patch.yml`, the Remora core, the hub connection.
- The legacy-mode `ask_user_question` tool itself (it passes no call id; covered by unit tests and the E2E run), `exit_plan_mode` plan reviews (plan mode is not composed; unit tests only), DSH Web's card being withdrawn when an outside answer wins (no gateway here; unit tests and the E2E run), approvals asked by a real tool's permission prompt (the request is made directly), goals (`ctx.goals`), slash commands (`ctx.commands`), background jobs (`ctx.jobs`), workspace changes and deliverables (`workspaceChanges`, `present` tool), the skill catalog (`sessionSkillCatalog` needs `workingDirectory`, not composed), `selectModel` / `modelCatalog` against real providers, agent presets other than the default, subagent sessions, `workspace.create` with a real `git` (covered by unit tests with a fake git).
- DSH Web presence (`hasLiveClient` is a heuristic; the gateway's `hasLiveClient()` that decides the answer deadline is not composed), multiple processes, Windows.
- Unpinned DSH versions: run with `DSH_UPSTREAM_DIR` pointing at another checkout to try one.
