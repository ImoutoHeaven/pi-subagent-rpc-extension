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
| `run` | `name`, `message`, `model`, `cwd`, `args`, `waitMs` | Hires a member named `name` and starts it on `message`. |
| `status` | `id`, `waitMs` | Reports progress or the result. Without `id`, lists every member. |
| `abort` | `id` | Stops the current run. A run that Pi has not started yet, or that does not stop within 10 seconds, is killed; a wake still waiting for the previous process never starts. The member then wakes only for a direct message from the main agent. |

- `name`: required, and the member's id. Names are 2 to 24 lowercase letters, digits, or hyphens, start with a letter, and do not end with a hyphen. `main`, `all`, and `team` are reserved, and a name is used once per team: `run` on an existing member fails, and a direct message gives it more work.
- `message`: the task. A member starts with an empty conversation, so `message` carries the context it needs.
- `model`: a Pi model pattern, `provider/id[:thinking]`. Default: the parent's current model and thinking level.
- `cwd`: the member's working directory, relative to the parent's. Default: the parent's.
- `args`: extra Pi command-line options, such as `--tools`, `--no-extensions`, `-e`, `--no-mcp`, or `--thinking`. The extension sets the mode, session, and model flags itself and rejects them here, along with args that remove the `team` tool.

## Waiting and results

`run` and `status` wait up to `waitMs` (default 30000, maximum 240000). A member that finishes in time returns its final reply as the tool result. Otherwise the result is a progress report and the member keeps running:

```text
[running] subagent reviewer · openai/gpt-5 · turn 4 · bash 2m10s · last event 3s ago · 5m02s
[t3] Running the full test suite now.
```

Each result for the main agent reaches it once. A result that no tool call returned arrives as a `subagent-result` message. Team messages for the main agent arrive the same way, as `team-message` messages:

- An idle parent starts a turn with the message.
- A running parent gets every message that arrived meanwhile together, after its current tool calls and before its next model request. The extension adds them to the session itself, so Pi's `steeringMode` does not space them out. A `run`, `status`, or `team wait` call ends its wait early when such a message arrives, and the terminal shows a one-line notice.
- After a run of the parent ends aborted, as with Esc, messages are added to the session without starting a turn, and the terminal shows a notice. The parent sees them when its next run starts, whoever starts it; from then on messages start turns again.

A later tool call about a delivered member shows its status line, where the result went, and the path of its `final.md`. A final result that a tool call would return while one of that member's team messages still waits is sent as a message behind it, so the result stays the last word. Replies over 16000 characters are truncated in the result; `final.md` in the member's directory holds the full text.

Results about one member end with the other members still running, up to three:

```text
(Background: reviewer running 4m10s, tester running 12m00s · no event 9m00s.)
```

`no event` appears after a minute without activity. A progress report or footer entry with no active tool and an old last event points to a stalled member.

Progress reports and results also show a `Notices:` line with the last three `ctx.ui.notify` texts that the member's extensions sent after the run started, such as the reason an extension stopped it.

## The `team` tool

The main agent (`main`) and every member have it.

| Action | Parameters | Behavior |
|---|---|---|
| `send` | `body`, `to`, `mentions`, `replyTo` | Posts to the board (no `to`) or sends a direct message to `to`. Returns `#seq` and what happened for each recipient. |
| `history` | `with`, `query`, `before`, `limit` | Reads the board, or the caller's direct messages with `with`. `query` matches text case-insensitively. Oldest first, at most `limit` messages (default 20, maximum 50) and 16000 characters; `before=<seq>` pages back. |
| `wait` | `ms` | Returns once a message for the caller is pending, or after `ms` (default 30000, maximum 240000). The messages follow the tool result. |
| `members` | | Members, their states, and the topic. |
| `topic` | `body` | Sets the topic (main agent only). |

`body` holds up to 4000 characters and `topic` up to 2000. Larger content belongs in files in the shared working tree, with the path in the message.

A direct message notifies its recipient. A board post notifies the members in `mentions` and the author of `replyTo`; others see it in `history`. Only the main agent can mention `all`. Every member sees the whole board and the direct messages it sent or received.

A member reads its messages at safe points: at the start of each run along with a preamble that names the team, after tool results, and when its run would end, in which case the run continues with them.

A direct message to a stopped member wakes it: the member runs again in its own session, and its messages arrive at the start of that run. Board posts never wake. The `send` result shows each recipient as `main`, `running`, `woken`, or stopped and why:

| Recipient | Result |
|---|---|
| Running member | `running`: it reads the message at its next safe point. |
| Stopped, direct message from the main agent, or from a member that `run` or the main agent's message started | `woken`. |
| Stopped, direct message from a run that another member's message woke | Not woken: such a run cannot start others. |
| Stopped, direct message from a member after the main agent aborted the recipient | Not woken: only the main agent's direct message wakes it. |
| Stopped, board post | Not woken. |

A direct message that cannot wake its recipient waits in the recipient's inbox, and the main agent gets a one-line `team-notice` that never starts a turn: an idle main agent sees it at once, a busy one at its next turn boundary. A direct message that arrives after a member's last read of its run is routed the same way once the run ends; its sender, if still running, then also gets a notice.

The final reply of a run woken by member X goes to X as a direct message holding the reply, cut to fit, and the path of `final.md`. When X has stopped, the reply goes to the main agent as a `subagent-result` marked `woken by X; X had stopped`. Every other run's result goes to the main agent.

A member's message renders as:

```text
[team #42] reviewer → #team, replying to #40, mentions you:
The parser change breaks the fixture in test/cases/7.json.
```

## Sessions and processes

- Member sessions are stored beside the parent session file, in `<parent session>/subagents/<name>/`. A parent without a session file uses the system temporary directory.
- The team log, `<parent session>/team.jsonl`, records members and messages. The first record written creates it, and it holds the team of that session only: a fork or clone of the session in Pi starts its own team.
- When the session is opened again, every member is listed as `stopped` and no member process starts. The main agent receives, without starting a turn, the team messages its session lacks.
- The child runs the parent's Node.js executable with the RPC entry point of the parent's Pi package, so both use the same Pi build, also when the parent is an SDK host such as pi-web. Each run is one process: it starts with `run` or a wake and ends when the run settles.
- Children cannot delegate: a member gets the `team` tool, never `subagent`. A member whose run starts without this extension loaded fails with an error.
- A child talks to the parent through extension dialogs on its own RPC pipe. Its other extension dialogs are cancelled, since no user can answer them.
- When the parent session ends, reloads, or switches, every running member is aborted and its process ends. The team log stays.
- Two Pi processes on the same parent session are unsupported: both would append to the team log.

## Test

The end-to-end test drives parent Pi processes over RPC against a scripted model and a throwaway agent directory. Each parent runs Pi's CLI inside a small host script, as an SDK host does.

- `npm test` runs a typecheck and the end-to-end test in a `node:24-bookworm` container. It requires Docker.
- `PI_CLI=/path/to/cli.js bash test/local.sh` runs the end-to-end test against the Pi CLI entry (`cli.js`) that `PI_CLI` names.
