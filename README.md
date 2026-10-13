# pi-subagent-rpc-extension

A [Pi](https://pi.dev) extension that gives a session a team of subagents. Each subagent is a named member: a separate `pi --mode rpc` process with its own session. It loads tools, extensions, skills, and MCP servers the way a normal Pi launch does, and it lives only as long as the parent session. Members talk with each other and with the main agent through a shared board and direct messages.

`team send` is the only way to send a message. A message reaches its recipient at the recipient's next safe point. A direct message to a stopped member wakes it, except that a run woken by another member cannot wake anyone. A run's final reply goes to whoever started that run.

Requires Pi 1.1.0.

## Install

```sh
pi install /path/to/pi-subagent-rpc-extension
```

To try it for one run: `pi -e /path/to/pi-subagent-rpc-extension`. Subagents do not inherit `-e`, so such a trial must also pass `args: ["-e", "/absolute/path/to/pi-subagent-rpc-extension"]` on each `subagent run`; an installed extension loads in subagents by itself.

## The `subagent` tool

| Action | Parameters | Behavior |
|---|---|---|
| `run` | `name`, `description`, `message`, `model`, `cwd`, `args`, `waitMs` | Hires a member named `name`, announces it on the board, and starts it on `message`. |
| `status` | `id`, `waitMs` | Reports progress or the result. Without `id`, lists every member. |
| `abort` | `id`, `retire` | Stops the member's run or compaction, if any, and cancels a queued compaction. A run that Pi has not started yet, or that does not stop within 10 seconds, is killed; a wake still waiting for the previous process never starts. The member then wakes only for a direct message from the main agent. With `retire: true`, the member, running or stopped, also leaves the team. |
| `compact` | `id`, `instructions`, `message`, `waitMs` | Compacts the member's context with Pi's compaction; see [Compaction](#compaction). |
| `switch` | `id`, `model`, `thinking`, `message`, `waitMs` | Moves the member to another model or thinking level from its next run; see [Switching models](#switching-models). |

- `name`: required, and the member's id. Names are 2 to 24 lowercase letters, digits, or hyphens, start with a letter, and do not end with a hyphen. `main`, `all`, and `team` are reserved, and a name is used once per team: `run` on an existing or retired member fails, and a direct message gives an existing member more work.
- `description`: required, the member's lasting role rather than its current task, in one line of at most 100 characters, such as `runs the e2e suite and reports failures`. The team roster shows it, and hiring posts `joined: <name> — <description>` to the board from `main`.
- `message`: the task. A member starts with an empty conversation, so `message` carries the context it needs. For `compact`, the task the member runs once compacted; for `switch`, the task a stopped member runs at once. A fresh member with a self-contained `message` suits a different domain or a new task; a stopped member compacted with instructions that keep what helps, then given the task, suits continuing its work or similar work that its earlier context helps with.
- `retire`: required for `abort`. `true` retires the member, running or stopped: it leaves the team for good. The roster, `members`, `status` without `id`, and the background footer leave it out, `all` does not cover it, and nothing wakes it again. A direct message or mention naming it fails with `tester is retired`, as do `compact` and `switch`, and a reply to its message does not notify it. `status` with its `id` still shows its last result, and its session, `final.md`, and team log records stay. The result lists the direct messages that reached it after its last read in this session, or after the session was reopened: `tester is retired: it left the team; its session and final.md stay. tester had 2 unread messages: #41, #45.` `false` only stops the member.
- `instructions`: for `compact`, Pi's custom instructions for the summary, saying what it keeps; up to 4000 characters.
- `model`: a Pi model pattern, `provider/id[:thinking]`. Default: the parent's current model and thinking level. For `switch`, the member's new model.
- `thinking`: for `switch`, a Pi thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- `cwd`: the member's working directory, relative to the parent's. Default: the parent's.
- `args`: extra Pi command-line options, such as `--tools`, `--no-extensions`, `-e`, or `--no-mcp`. The extension sets the mode, session, model, provider, and thinking flags itself and rejects them here, along with args that remove the `team` tool; `model` carries the provider and thinking level.

## Waiting and results

`run`, `status`, `compact`, and `switch` with `message` wait up to `waitMs` (default 30000, maximum 240000); `waitMs: 0` returns at once. A member that finishes in time returns its final reply as the tool result. Otherwise the result is a progress report and the member keeps running:

```text
[running] subagent reviewer · openai/gpt-5 · turn 4 · bash (npm test -- --reporter dot) 2m10s · last event 3s ago · 5m02s · 48.2K in · 3.1K out · 1.2M cached · $0.42
[t3] Running the full test suite now.
```

To wait longer, the main agent calls `status` again: each wait of at most 4 minutes ends within the 5-minute lifetime of Anthropic's prompt cache, which keeps the cache warm. Or it ends its turn: each result and message for it starts its next turn, as described below.

Once a run ends, its status line names the model with its thinking level, such as `openai/gpt-5:high`. The status line of a progress report shows each running tool with its main argument, such as its command, path, code, or query, in one line cut to about 60 characters. The status line of a progress report or result ends with the run's token usage, summed over its model replies: input tokens, cache writes included; output tokens; cache reads, when there are any; and the cost, when the model has a price.

Once known, the status line also shows the member's context as `ctx 212K/300K 71%`: the context tokens of its last model reply, or Pi's estimate after its last compaction, against its [compact point](#compaction). The context stays known across runs. A run that did not settle ends its status line with how it ended:

```text
[error] subagent tester · openai/gpt-5:high · 3 turns · 2m10s · 48.2K in · 3.1K out · ctx 52K/300K 17% · stream error: stream disconnected before completion: stream closed before response.completed (Pi retried 0 times)
[aborted] subagent tester · openai/gpt-5:high · 2 turns · 41s · 20.1K in · 1.2K out · ctx 31K/300K 10% · by an extension
```

- `[error]`: the error in one line, followed in full when it is longer, and, for a failed model request, how many times Pi retried it. Retries are Pi's own; a progress report shows one in progress as `retrying (2/3): <error>`.
- `[aborted]`: `by main` after `abort`, or `by an extension` when an extension inside the member aborted the run, such as with `ctx.abort()`.

The main agent also gets `subagent-notice` messages, which never start a turn: about Pi's compaction of a running member, about a member's message that woke a member whose last run ended in an error or was aborted (`[subagent] tester resumed (woken by reviewer) after its run ended in an error.`), and about an error in a run that a member's message started while that member still runs, since the final reply goes to that member. When a run ends in an error, each running member that sent it a direct message during the run gets `[team] tester stopped on an error; the main agent was told.`

Each result for the main agent reaches it once; after a move in the session tree, each member's latest result also reaches the new branch once if that branch lacks it. A result that no tool call returned arrives as a `subagent-result` message. Team messages for the main agent arrive the same way, as `team-message` messages:

- An idle parent starts a turn with the message.
- A running parent gets every message that arrived meanwhile together, after its current tool calls and before its next model request. The extension adds them to the session itself, so Pi's `steeringMode` does not space them out. The parent has received a message once the current branch of its session holds it, so a message in a batch another extension dropped arrives at the next turn boundary. A `run`, `status`, or `team wait` call ends its wait early when such a message arrives, and the terminal shows a one-line notice.
- After a run of the parent ends aborted, as with Esc, messages are added to the session without starting a turn, and the terminal shows a notice. The parent sees them when its next run starts, whoever starts it; from then on messages start turns again.

A later tool call about a delivered member shows its status line, where the result went, and the path of its `final.md`. A final result that a tool call would return while one of that member's team messages still waits is sent as a message behind it, so the result stays the last word. Replies over 16000 characters are truncated in the result; `final.md` in the member's directory holds the full text.

Results about one member end with the other members still running, up to three:

```text
(Background: reviewer running 4m10s · ctx 212K/300K 71%, tester compacting 12s, coder running 12m00s · no event 9m00s.)
```

`no event` appears after a minute without activity; `compacting` marks a member in a [compaction](#compaction) run. Retired members never appear there. A progress report or footer entry with no active tool and an old last event points to a stalled member.

Progress reports and results also show a `Notices:` line with the last three `ctx.ui.notify` texts that the member's extensions sent after the run started, such as the reason an extension stopped it.

## Compaction

Pi compacts a running member's context itself once the context passes the member's compact point: the model's context window minus `compaction.reserveTokens` from Pi's settings, which `compaction.modelOverrides` sets per model. For example, a 1M-token model with

```json
{ "compaction": { "modelOverrides": { "some-provider/big-model": { "reserveTokens": 700000 } } } }
```

compacts above about 300K tokens. The `ctx` share uses the same compact point, read through Pi's settings for the member's working directory; with `compaction.enabled` set to false, it uses the context window. During a compaction the progress report shows `compacting`. Afterwards the run's status line shows `compacted 312K→24K (threshold)`, with `overflow` or `manual` for the other kinds, or `compaction failed: <reason>`, and the main agent gets a `subagent-notice`.

`compact` compacts a member on request; a member that is past about 60% of its compact point and about to take a new or unrelated task, or that holds much the next task does not need, is a candidate.

- A stopped member compacts at once in a process of its own. A result of its last run that the main agent has not received arrives first. Meanwhile the member's state is `compacting`, and it is never woken: a direct message to it shows `compacting; reads it afterwards` and is routed when the compaction ends, as for a message that reached a run after its last read.
- A running member compacts after its current run's process exits, and the result reads `Compaction queued after the current run.` A second `compact` before the compaction ends fails.
- `abort` cancels a queued compaction or stops the compaction in progress, after which Pi records no compaction, and locks the member as after any abort.
- A compacted member's result reads `[compacted] subagent tester · openai/gpt-5:high · 18s · ctx 24K/300K 8% · compacted 312K→24K (manual)`; Pi's `Nothing to compact (session too small)` and `Already compacted` also end as `[compacted]`, with that text. A failure, such as an extension that cancels the compaction or a provider error, ends as `[error] … · compaction failed: <reason>`, with the extensions' notices.
- With `message`, a compacted member then runs on `message` as if the main agent started it, which also unlocks a member the main agent aborted; that run's result arrives as usual and its status line shows the compaction. After a failure the member does not run, and the result starts a turn.
- Without `message`, a result that `waitMs` does not cover arrives as a `subagent-result` that starts no turn, and a locked member stays locked.

The member's extensions take part in both kinds of compaction as in any Pi session, for example through `session_before_compact`.

## Switching models

`switch` moves a member to another model, thinking level, or both, from its next run. The member keeps its name, session, and context. Pi resolves `model` and `thinking` when that run starts and fits the level to what the model supports; a model Pi cannot resolve ends the run as `[error]` with Pi's reason.

- A model switch keeps the member's thinking level, and a thinking switch keeps its model. The team log records the new settings, so a reopened session keeps them.
- The result reads `tester now runs on openai/gpt-5:high from its next run (was openai/gpt-5-mini:medium). ctx 212K — its next request pays full input price for that context.` The `ctx` part comes with a model change once the member's context is known: the new model starts without the prompt cache, so its next request pays full input price for the whole context. A large context is cheaper to [compact](#compaction) first.
- A run or compaction already under way keeps the settings it started with, as does a wake that waits for the previous run's process to exit. A queued compaction and every later run use the new settings.
- With `message`, a stopped member runs on `message` at once, as if the main agent started it, which also unlocks a member the main agent aborted, and the call waits as `run` does. A running or compacting member takes `message` after it stops: `switch` with `message` on it returns an error.

## The `team` tool

The main agent (`main`) and every member have it.

| Action | Parameters | Behavior |
|---|---|---|
| `send` | `body`, `to`, `mentions`, `replyTo` | Posts to the board (no `to`) or sends one direct message to `to`, a member name, `main`, or a list of them. Returns `#seq` and what happened for each recipient. |
| `history` | `with`, `query`, `before`, `limit` | Reads the board, or the caller's direct messages with `with`; for the main agent, every direct message of the member named in `with`. `query` matches text case-insensitively. Oldest first, at most `limit` messages (default 20, maximum 50) and 16000 characters; `before=<seq>` pages back. |
| `wait` | `ms` | Returns once a message for the caller is pending, or after `ms` (default 30000, maximum 240000). The messages follow the tool result. |
| `members` | | Members with their states (`running`, `compacting`, `stopped`, `stopped (error)`, or `stopped (aborted)`) and roles, such as `- tester: running — runs the e2e suite and reports failures`, and the topic. Retired members are left out, here and in a member's preamble. |
| `topic` | `body` | Sets the topic (main agent only). |

`body` holds up to 4000 characters and `topic` up to 2000. Larger content belongs in files in the shared working tree, with the path in the message.

Every member sees the whole board and the direct messages it sent or received, each with all of its recipients. The main agent also reads every member's direct messages with `history`. A message reaches the main agent and the members at one of three levels:

| Message | Recipient gets | Wakes a stopped member |
|---|---|---|
| Direct message | The full text at its next safe point | Yes, by the rules below |
| Board post that mentions the recipient or replies to its message, or the main agent's post mentioning `all` | The full text at its next safe point | No |
| Any other board post by someone else | A line in the board digest | No |

Only the main agent can mention `all`. A join announcement mentions no one, so the other members get it in their board digest.

The board digest is one line about the board posts the recipient has not seen: the latest three, each cut to about 80 characters, and a count of the earlier ones with the `history` call that reads them.

```text
[team] Board: 5 new posts — #14 tester: Fixture 7 fails on Windows paths; #15 reviewer: The parser change looks right; #16 main: Freeze the API; +2 earlier (team history before=14).
```

A member gets the digest at the start of a run and after tool results. The main agent gets it as a `team-notice` after a turn with tool calls and at the start of each run. A post that a `history` result shows stays out of later digests. A new member's first digest covers the board posts from before it joined, without its own join announcement. Each agent's place on the board follows the current branch of its session, so after the session is reopened or the main agent moves in the session tree, its digest lists the posts that branch has not seen. A digest never counts for `team wait`, never wakes anyone, and never continues a run by itself.

A member reads its messages at safe points: at the start of each run along with a preamble that names the team, lists its members, and states the rules of that run (whether its direct messages wake stopped members, that news that need not wake anyone goes on the board with a mention, that only the main agent hires, where its final reply goes, and which messages that reply cites by `#seq` instead of repeating them), after tool results, and when its run would end, in which case the run continues with them. A member has read a message once the current branch of its session holds it, so a message that never joined that branch, such as one in a batch another extension dropped, arrives at the next safe point.

A direct message to a stopped member wakes it: the member runs again in its own session, and its messages arrive at the start of that run. Board posts never wake. The `send` result shows each recipient as `main`, `running`, `woken`, or stopped and why:

| Recipient | Result |
|---|---|
| Running member | `running`: it reads the message at its next safe point. |
| Member in a compaction run | `compacting; reads it afterwards`: once the compaction ends, the message is routed as for a stopped member. |
| Stopped, direct message from the main agent, or from a member that `run` or the main agent's message started | `woken`. |
| Stopped, direct message from a run that another member's message woke | Not woken: such a run cannot start others. |
| Stopped, direct message from a member after the main agent aborted the recipient | Not woken: only the main agent's direct message wakes it. |
| Stopped, board post | Not woken. |

A direct message that cannot wake its recipient waits in the recipient's inbox, and the main agent gets a one-line `team-notice` about it, delivered like a team message: it starts a turn of an idle main agent and reaches a busy one at its next turn boundary. A direct message that arrives after a member's last read of its run is routed the same way once the run ends; its sender, if still running, then also gets a notice.

The final reply of a run woken by member X goes to X as a direct message holding the reply, cut to fit, and the path of `final.md`. When X has stopped, the reply goes to the main agent as a `subagent-result` marked `woken by X; X had stopped`. Every other run's result goes to the main agent.

A member's message renders as:

```text
[team #42] reviewer → #team, replying to #40, mentions you:
The parser change breaks the fixture in test/cases/7.json.

[team #43] main → you, tester (direct):
Fix the fixture named in #42, then rerun the suite.
```

## Sessions and processes

- Member sessions are stored beside the parent session file, in `<parent session>/subagents/<name>/`. A parent without a session file uses the system temporary directory.
- The team log, `<parent session>/team.jsonl`, records members and messages. The first record written creates it, and it holds the team of that session file only: a fork, clone, or import of the session in Pi starts its own team. After `/fork` or `/clone`, the main agent gets a notice that the copied team messages belong to the original session's team; `pi --fork` starts the new team without that notice.
- When the session is opened again, every member is listed as `stopped` and no member process starts. When the session is opened and when the main agent moves in the session tree, the main agent receives, without starting a turn, the team messages to or from it that the current branch lacks: the latest ten in full, and one line that counts the earlier ones and those that the summary of the branch it left covers. After a move in the tree, it also receives the latest result of each member that the branch lacks.
- The child runs the parent's Node.js executable with the RPC entry point of the parent's Pi package, so both use the same Pi build, also when the parent is an SDK host such as pi-web. Each run is one process: it starts with `run` or a wake and ends when the run settles.
- Children cannot delegate: a member gets the `team` tool, never `subagent`. A member whose run starts without this extension loaded fails with an error.
- A child talks to the parent through extension dialogs on its own RPC pipe. Its other extension dialogs are cancelled, since no user can answer them.
- When the parent session ends, reloads, or switches, every running member is aborted and its process ends. The team log stays.
- Two Pi processes on the same parent session are unsupported: both would append to the team log.

## Test

The end-to-end test drives parent Pi processes over RPC against a scripted model and a throwaway agent directory. Each parent runs Pi's CLI inside a small host script, as an SDK host does.

- `npm test` runs a typecheck and the end-to-end test in a `node:24-bookworm` container. It requires Docker.
- `PI_CLI=/path/to/cli.js bash test/local.sh` runs the end-to-end test against the Pi CLI entry (`cli.js`) that `PI_CLI` names.
