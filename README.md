# pi-subagent-rpc-extension

A [Pi](https://pi.dev) extension that gives a session a team of subagents. Each subagent is a named member: a separate `pi --mode rpc` process with its own session. It loads tools, extensions, skills, and MCP servers the way a normal Pi launch does, and it lives only as long as the parent session. Members talk with each other and with the main agent through a shared board and direct messages.

Communication never starts work: only the main agent's `subagent` calls start, steer, resume, or stop a member.

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
| `steer` | `id`, `message` | Redirects a running member after its current tool calls. |
| `follow_up` | `id`, `message`, `waitMs` | Sends the next request. A stopped member restarts in its own session. |
| `abort` | `id` | Stops the current run; a child that does not stop within 10 seconds is killed. |

- `name`: required, and the member's id. Names are 2 to 24 lowercase letters, digits, or hyphens, start with a letter, and do not end with a hyphen. `main`, `all`, and `team` are reserved, and a name is used once per team.
- `message`: the task. A member starts with an empty conversation, so `message` carries the context it needs.
- `model`: a Pi model pattern, `provider/id[:thinking]`. Default: the parent's current model and thinking level.
- `cwd`: the member's working directory, relative to the parent's. Default: the parent's.
- `args`: extra Pi command-line options, such as `--tools`, `--no-extensions`, `-e`, `--no-mcp`, or `--thinking`. The extension sets the mode, session, and model flags itself and rejects them here, along with args that remove the `team` tool.

## Waiting and results

`run`, `status`, and `follow_up` wait up to `waitMs` (default 30000, maximum 240000). A member that finishes in time returns its final reply as the tool result. Otherwise the result is a progress report and the member keeps running:

```text
[running] subagent reviewer · openai/gpt-5 · turn 4 · bash 2m10s · last event 3s ago · 5m02s
[t3] Running the full test suite now.
```

Each member's result reaches the parent once. A result that no tool call returned arrives as a `subagent-result` message. Team messages for the main agent arrive the same way, as `team-message` messages:

- An idle parent starts a turn with the message.
- A running parent gets every message that arrived meanwhile together, after its current tool calls and before its next model request. The extension adds them to the session itself, so Pi's `steeringMode` does not space them out. A `run`, `status`, `follow_up`, or `team wait` call ends its wait early when such a message arrives, and the terminal shows a one-line notice.
- After the user stops the parent with Esc, messages are added to the session without starting a turn, and the terminal shows a notice. The parent sees them at the user's next prompt, which also lets later messages start turns again.

A later tool call about a delivered member shows its status line, where the result went, and the path of its `final.md`. A final result that a tool call would return while one of that member's team messages still waits is sent as a message behind it, so the result stays the last word. Replies over 16000 characters are truncated in the result; `final.md` in the member's directory holds the full text.

Results about one member end with the other members still running, up to three:

```text
(Background: reviewer running 4m10s, tester running 12m00s · no event 9m00s.)
```

`no event` appears after a minute without activity. A progress report or footer entry with no active tool and an old last event points to a stalled member. Abort it and resume it with `follow_up`.

## The `team` tool

The main agent (`main`) and every member have it.

| Action | Parameters | Behavior |
|---|---|---|
| `send` | `body`, `to`, `mentions`, `replyTo` | Posts to the board (no `to`) or sends a direct message to `to`. Returns `#seq` and each recipient's state. |
| `history` | `with`, `query`, `before`, `limit` | Reads the board, or the caller's direct messages with `with`. `query` matches text case-insensitively. Oldest first, at most `limit` messages (default 20, maximum 50) and 16000 characters; `before=<seq>` pages back. |
| `wait` | `ms` | Returns once a message for the caller is pending, or after `ms` (default 30000, maximum 240000). The messages follow the tool result. |
| `members` | | Members, their states, and the topic. |
| `topic` | `body` | Sets the topic (main agent only). |

`body` holds up to 4000 characters and `topic` up to 2000. Larger content belongs in files in the shared working tree, with the path in the message.

A direct message notifies its recipient. A board post notifies the members in `mentions` and the author of `replyTo`; others see it in `history`. Only the main agent can mention `all`. Every member sees the whole board and the direct messages it sent or received.

A running member gets its messages at its next model request that follows tool results, and at the start of each run along with a preamble that names the team and its rules. A stopped member gets them when the main agent resumes it.

A member's message renders as:

```text
[team #42] reviewer → #team, replying to #40, mentions you:
The parser change breaks the fixture in test/cases/7.json.
```

## Sessions and processes

- Member sessions are stored beside the parent session file, in `<parent session>/subagents/<name>/`. A parent without a session file uses the system temporary directory.
- The team log, `<parent session>/team.jsonl`, records members and messages. The first record written creates it, and it holds the team of that session only: a fork or clone of the session in Pi starts its own team.
- When the session is opened again, every member is listed as `stopped` and no member process starts. The main agent receives, without starting a turn, the team messages its session lacks.
- The child runs the parent's Node.js executable with the RPC entry point of the parent's Pi package, so both use the same Pi build, also when the parent is an SDK host such as pi-web. Each run is one process: it starts with `run` or `follow_up` and ends when the run settles.
- Children cannot delegate: a member gets the `team` tool, never `subagent`. A member whose run starts without this extension loaded fails with an error.
- A child talks to the parent through extension dialogs on its own RPC pipe. Its other extension dialogs are cancelled, since no user can answer them.
- When the parent session ends, reloads, or switches, every running member is aborted and its process ends. The team log stays.
- Two Pi processes on the same parent session are unsupported: both would append to the team log.

## Test

The end-to-end test drives parent Pi processes over RPC against a scripted model and a throwaway agent directory. Each parent runs Pi's CLI inside a small host script, as an SDK host does.

- `npm test` runs a typecheck and the end-to-end test in a `node:24-bookworm` container. It requires Docker.
- `PI_CLI=/path/to/cli.js bash test/local.sh` runs the end-to-end test against the Pi CLI entry (`cli.js`) that `PI_CLI` names.
