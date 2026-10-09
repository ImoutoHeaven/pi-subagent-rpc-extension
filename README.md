# pi-subagent-rpc-extension

A [Pi](https://pi.dev) extension that adds one tool, `subagent`. Each subagent is a separate `pi --mode rpc` process with its own session. It loads tools, extensions, skills, and MCP servers the way a normal Pi launch does, and it lives only as long as the parent session.

Requires Pi 1.1.0.

## Install

```sh
pi install /path/to/pi-subagent-rpc-extension
```

To try it for one run: `pi -e /path/to/pi-subagent-rpc-extension`.

## The `subagent` tool

| Action | Parameters | Behavior |
|---|---|---|
| `run` | `message`, `context`, `model`, `cwd`, `args`, `waitMs` | Starts a subagent on `message`. |
| `status` | `id`, `waitMs` | Reports progress or the result. Without `id`, lists every subagent. |
| `steer` | `id`, `message` | Redirects a running subagent after its current tool calls. |
| `follow_up` | `id`, `message`, `waitMs` | Sends the next request. A finished subagent restarts in its own session. |
| `abort` | `id` | Stops the current run; a child that does not stop within 10 seconds is killed. |

- `context`: `fresh` (default) starts with an empty conversation. `fork` copies the parent conversation's current branch.
- `model`: a Pi model pattern, `provider/id[:thinking]`. Default: the parent's current model and thinking level.
- `cwd`: the subagent's working directory, relative to the parent's. Default: the parent's.
- `args`: extra Pi command-line options, such as `--tools`, `--no-extensions`, `-e`, `--no-mcp`, or `--thinking`. The extension sets the mode, session, and model flags itself and rejects them here.

## Waiting and results

`run`, `status`, and `follow_up` wait up to `waitMs` (default 30000, maximum 240000). A subagent that finishes in time returns its final reply as the tool result. Otherwise the result is a progress report and the subagent keeps running:

```text
[running] subagent 3fa91c · openai/gpt-5 · turn 4 · bash 2m10s · last event 3s ago · 5m02s
[t3] Running the full test suite now.
```

Each subagent's result reaches the parent once. A result that no tool call returned arrives as a `subagent-result` message, which starts a parent turn or follows the current one. Replies over 16000 characters are truncated in the result; `final.md` in the subagent's directory holds the full text.

A report with no active tool and an old `last event` points to a stalled subagent. Abort it and run a new one.

## Sessions and processes

- Subagent sessions are stored beside the parent session file, in `<parent session>/subagents/<id>/`. A parent without a session file uses the system temporary directory.
- `fork` requires a saved parent session. The child sees the pending `subagent` call that created it as a tool call without a result.
- The child runs the parent's Node.js executable and Pi entry point, so both use the same Pi build.
- Children cannot delegate: the extension registers nothing inside a subagent.
- A child's extension dialogs are cancelled, since no user can answer them.
- When the parent session ends, reloads, or switches, every running subagent is aborted and its process ends.

## Test

The end-to-end test drives a parent Pi over RPC against a scripted model and a throwaway agent directory.

- `npm test` runs a typecheck and the end-to-end test in a `node:24-bookworm` container. It requires Docker.
- `bash test/local.sh` runs the end-to-end test against the Pi on this machine. Set `PI_CLI` to a Pi CLI entry (`cli.js`) to choose one; otherwise it runs `pi` from `PATH`.
