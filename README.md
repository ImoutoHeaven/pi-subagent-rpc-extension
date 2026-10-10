# pi-subagent-rpc-extension

A [Pi](https://pi.dev) extension that gives a session subagents. Each subagent is a separate `pi --mode rpc` process with its own session. It loads tools, extensions, skills, and MCP servers the way a normal Pi launch does, and it lives only as long as the parent session.

A session runs in one of two modes:

- **Normal mode** (default): one-off helpers. A subagent starts empty or as a fork of the conversation and talks to the main agent through `report_to_main_agent` and its final reply.
- **Team mode**: named, durable members that talk with each other and with the main agent through a shared board and direct messages.

Communication never starts work: only the main agent's `subagent` calls start, steer, resume, or stop a subagent.

Requires Pi 1.1.0.

## Install

```sh
pi install /path/to/pi-subagent-rpc-extension
```

To try it for one run: `pi -e /path/to/pi-subagent-rpc-extension`. Subagents do not inherit `-e`, so such a trial must also pass `args: ["-e", "/absolute/path/to/pi-subagent-rpc-extension"]` on each `subagent run`; an installed extension loads in subagents by itself.

## The `subagent` tool

| Action | Parameters | Behavior |
|---|---|---|
| `run` | `message`, `name` (team mode), `context`, `model`, `cwd`, `args`, `waitMs` | Starts a subagent on `message`. |
| `status` | `id`, `waitMs` | Reports progress or the result. Without `id`, lists every subagent. |
| `steer` | `id`, `message` | Redirects a running subagent after its current tool calls. |
| `follow_up` | `id`, `message`, `waitMs` | Sends the next request. A finished subagent restarts in its own session. |
| `abort` | `id` | Stops the current run; a child that does not stop within 10 seconds is killed. |

- `context`: `fresh` (default) starts with an empty conversation. `fork` copies the parent conversation's current branch and opens the task with a note telling the subagent that it is a subagent, not the main agent.
- `model`: a Pi model pattern, `provider/id[:thinking]`. Default: the parent's current model and thinking level.
- `cwd`: the subagent's working directory, relative to the parent's. Default: the parent's.
- `args`: extra Pi command-line options, such as `--tools`, `--no-extensions`, `-e`, `--no-mcp`, or `--thinking`. The extension sets the mode, session, and model flags itself and rejects them here.

In normal mode a subagent's id is 6 random hex digits. In team mode it is the member's name.

## Waiting and results

`run`, `status`, and `follow_up` wait up to `waitMs` (default 30000, maximum 240000). A subagent that finishes in time returns its final reply as the tool result. Otherwise the result is a progress report and the subagent keeps running:

```text
[running] subagent 3fa91c · openai/gpt-5 · turn 4 · bash 2m10s · last event 3s ago · 5m02s
[t3] Running the full test suite now.
```

Each subagent's result reaches the parent once. A result that no tool call returned arrives as a `subagent-result` message. Reports and team messages for the main agent arrive the same way:

- An idle parent starts a turn with the message.
- A running parent gets every message that arrived meanwhile together, after its current tool calls and before its next model request. The extension adds them to the session itself, so Pi's `steeringMode` does not space them out. A `run`, `status`, `follow_up`, or `team wait` call ends its wait early when such a message arrives, and the terminal shows a one-line notice.
- After the user stops the parent with Esc, messages are added to the session without starting a turn, and the terminal shows a notice. The parent sees them at the user's next prompt, which also lets later messages start turns again.

A later tool call about a delivered subagent shows its status line, where the result went, and the path of its `final.md`. A final result that a tool call would return while one of that subagent's reports or team messages still waits is sent as a message behind it, so the result stays the last word. Replies over 16000 characters are truncated in the result; `final.md` in the subagent's directory holds the full text.

Results about one subagent end with the other subagents still running, up to three:

```text
(Background: 3fa91c running 4m10s, 8b20d7 running 12m00s · no event 9m00s.)
```

`no event` appears after a minute without activity. A progress report or footer entry with no active tool and an old last event points to a stalled subagent. Abort it and run a new one.

`status` without `id` lists the session's subagents. In normal mode the list keeps up to 32: starting a new subagent forgets the earliest-finished ones beyond that, never a running one. In team mode it lists every member.

## Reports from subagents

In normal mode each subagent has one tool of its own, `report_to_main_agent`, for short messages the parent needs before the subagent finishes, such as a finding that changes the plan or a blocker. A report arrives as a `subagent-report` message, and the latest ones appear in progress reports. The parent answers with `steer`.

Args that keep the tool out of the subagent, such as `--no-extensions`, `--no-tools`, a `--tools` list without it, or a matching `--exclude-tools` pattern, add a note to the `run` result. Such a subagent reaches the parent only through its final reply.

## Team mode

The user runs `/team` to switch the session to team mode. The command needs a session file and a session that has not started any subagent yet. It creates the team log, `<parent session>/team.jsonl`, and activates the main agent's `team` tool. A session is in team mode exactly when that log exists, and it stays in team mode. A fork or clone of the session in Pi starts in normal mode.

In team mode, `subagent run` hires a member:

- `name` is required and becomes the id. Names are 2 to 24 lowercase letters, digits, or hyphens, start with a letter, and do not end with a hyphen. `main`, `all`, and `team` are reserved, and a name is used once per team.
- `context` must be `fresh`. Put the context the member needs in `message`.
- `args` that remove the `team` tool are rejected.

A member keeps its session in `<parent session>/subagents/<name>/`. `follow_up` resumes a stopped member in that session. When the session is opened again, every member is listed as `stopped` and no member process starts.

### The `team` tool

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

A running member gets its messages at its next model request that follows tool results, and at the start of each run along with a preamble that names the team and its rules. A stopped member gets them when the main agent resumes it. Messages for the main agent arrive as `team-message` messages, the same way as results. When the session is opened again, the main agent receives, without starting a turn, the messages its session lacks.

A member's message renders as:

```text
[team #42] reviewer → #team, replying to #40, mentions you:
The parser change breaks the fixture in test/cases/7.json.
```

## Sessions and processes

- Subagent sessions are stored beside the parent session file, in `<parent session>/subagents/<id>/`. A parent without a session file uses the system temporary directory.
- `fork` requires a saved parent session. The child sees the pending `subagent` call that created it as a tool call without a result.
- The child runs the parent's Node.js executable and Pi entry point, so both use the same Pi build. Each run is one process: it starts with `run` or `follow_up` and ends when the run settles.
- Children cannot delegate: a subagent gets `report_to_main_agent` (normal mode) or `team` (team mode), never `subagent`.
- A child talks to the parent through extension dialogs on its own RPC pipe. Its other extension dialogs are cancelled, since no user can answer them.
- When the parent session ends, reloads, or switches, every running subagent is aborted and its process ends. The team log stays.
- Two Pi processes on the same parent session are unsupported in team mode: both would append to the team log.

## Test

The end-to-end test drives parent Pi processes over RPC against a scripted model and a throwaway agent directory.

- `npm test` runs a typecheck and the end-to-end test in a `node:24-bookworm` container. It requires Docker.
- `bash test/local.sh` runs the end-to-end test against the Pi on this machine. Set `PI_CLI` to a Pi CLI entry (`cli.js`) to choose one; otherwise it runs `pi` from `PATH`.
