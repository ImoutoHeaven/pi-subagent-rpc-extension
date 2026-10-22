# pi-subagent-rpc-extension Reference

Authoritative tool schemas and RPC contracts live in
[`src/protocol.ts`](../src/protocol.ts), [`src/subagent.ts`](../src/subagent.ts),
[`src/team.ts`](../src/team.ts), [`src/child.ts`](../src/child.ts), and
[`src/rpc.ts`](../src/rpc.ts).

## 1. `subagent` Tool (`main` only)

- **`run`**: Hires a new member, posts `joined: <name> — <description>` to the
  board, and starts a `pi --mode rpc` run on `message`.
  - `name` (required): `2–24` chars matching `/^[a-z][a-z0-9-]{0,22}[a-z0-9]$/`.
    `main`, `all`, and `team` are reserved. Names are never reused within a team,
    including after retirement; use `team send` to message an existing member.
  - `description` (required): One-line role description, up to `100` characters.
  - `message` (required): Initial task prompt.
  - `model`: `provider/id[:thinking]`. Defaults to the parent's current model
    and thinking level.
  - `cwd`: Working directory (resolved from the parent's `cwd`).
  - `args`: Extra Pi CLI options (`--tools`, `--exclude-tools`, `-e`,
    `--no-mcp`). Cannot include mode, session, model, provider, or thinking
    flags (`--mode`, `--print`, `-p`, `--no-session`, `--session`,
    `--session-id`, `--session-dir`, `--continue`, `-c`, `--resume`, `-r`,
    `--fork`, `--export`, `--model`, `--provider`, `--thinking`), and cannot
    remove the `team` tool or unload this extension.
  - `waitMs`: `0–240000` (default `30000`). Waits up to `waitMs` for completion
    or an incoming message for `main`.
- **`status`**: Without `id`, lists non-retired members. With `id`, waits up to
  `waitMs` (`0–240000`, default `30000`) while busy and returns the progress
  report or final result (also works on retired members).
- **`abort`**: Requires `id` and `retire: true | false`, plus optional
  `when: "next" | "now"`.
  - Stops the run or compaction, cancels any queued compaction, and sets the
    abort lock (`stopped (only main wakes it)`). New work from `main` lifts it:
    a direct message, `switch` with `message`, or a post-compaction run with
    `message` and `wake: true`. `compact` with `wake: false` preserves the lock.
  - `retire: true` permanently removes the member from the active roster,
    `status` list, background footer, and `"all"` mentions; future `team send`,
    `compact`, or `switch` calls targeting it fail. Its session directory,
    `final.md`, and `team.jsonl` records remain on disk, and the result lists
    unread direct messages left in its inbox.
- **`compact`**: Requires `id`; accepts `instructions` (`<= 4000` chars),
  `message`, `wake` (default `true`; `false` requires `message`), `when`
  (`"next"` or `"now"`), and `waitMs`.
  - **Stopped member**: Runs a compaction process immediately; direct messages
    wait until compaction finishes (`compacting; reads it afterwards`).
    - Without `message`: Compacts and stays stopped.
    - With `message` and `wake: true` (default): Compacts, unlocks, and starts a
      new run on `message` as `main`.
    - With `message` and `wake: false`: Writes `message` verbatim into the
      member's session after the summary (`[team] main → you (direct), written after the compaction for your next run:`)
      and leaves the member stopped (and locked if locked). If no compaction
      completed (`Nothing to compact`, `Already compacted`, or error), `message`
      is not written and the result notifies `main`.
  - **Running member**: `when: "next"` (default) compacts at the next safe point
    and continues the run (reading `message` if given); if the run ends first,
    it compacts afterward as a stopped member. `when: "now"` stops the run
    immediately and compacts as a stopped member.
- **`switch`**: Requires `id` and `model` and/or `thinking` (`off`, `minimal`,
  `low`, `medium`, `high`, `xhigh`, `max`), plus optional `when`, `message`, and
  `waitMs`.
  - Updates `launchArgs` in `team.jsonl`. When the model changes and
    `contextTokens` is known, the result notes that the next request on the new
    model starts without a prompt cache and pays full input price.
  - Without `message`, a running member switches at its next safe point; a
    stopped or compacting member uses the new settings from its next run.
  - With `message`, a stopped member unlocks and runs on `message` at once; a
    busy member requires `when: "now"` to stop first and launch on `message`.

## 2. Safe Points and Process Termination

Children use the parent's executable and installed Pi package's `./rpc-entry`.
Standalone compiled hosts without that entry file are unsupported.

A running member reaches a safe point at `turn_end` after current tool calls
finish and before its next model request. A member waiting inside `team wait`
returns early when `main` queues a safe-point `abort`, `compact`, or `switch`.

For an immediate stop (`abort` with `when: "now"`, `abort` on a compaction run,
or `compact` / `switch` with `when: "now"`):

1. If Pi has not yet emitted `agent_start` (or `compaction_start` for a
   compaction run), process termination starts immediately.
2. Otherwise, the parent sends `{ type: "abort" }` over RPC stdin and waits up
   to `10` seconds (`ABORT_WAIT_MS`) for the run to conclude before termination.
   Windows uses `taskkill /PID <pid> /T /F`; POSIX sends `SIGTERM` to the Pi
   process, followed by `SIGKILL` after `1` s if needed. An unresponsive POSIX
   child may leave descendants; this is not an OS sandbox. The `10` s timeout
   does not bound queued `when: "next"` safe-point requests.

## 3. `team` Tool (`main` and all members)

- **`send`**: Omit `to` to post to the board (`#team`), or set `to` (member
  name, `"main"`, or array) for a direct message.
  - `title`: Required to start a board thread (`1–100` chars, single line);
    omitted on replies (`replyTo`) and direct messages.
  - `body`: Required (`1–8000` chars). Put larger content in files in the
    shared working tree and pass the path.
  - `mentions`: Optional member names on board posts (`["all"]` is `main` only).
  - `replyTo`: Optional `#seq`. Board posts reply to board posts; direct
    messages reply to either and include the target's author in `to`.
- **`history`**:
  - Default: Lists visible board threads by latest visible `#seq` (`limit`
    `1–50`, default `20`, up to `16000` chars), with `query`, `before`, `after`,
    and `order` (`"newest"` or `"oldest"`).
  - `with`: Lists direct messages with that member (`main` sees all of that
    member's direct messages).
  - `thread`: Pages the visible reply tree of `#seq` (`limit` default `50`, up
    to `16000` chars), oldest first in tree order; continue with
    `after=<highest seq on page>` (`with`, `query`, and `before` are rejected).
- **`wait`**: Waits up to `ms` (`0–240000`, default `30000`) for a pending
  message (or safe-point request from `main`).
- **`members`**: Lists `main`, active members with state and role, and topic.
- **`topic`**: Sets the team topic (`1–2000` chars, `main` only).

### Visibility, Digests, Wake Rules, and Replies

- **Visibility**: Members see the board and only direct messages they sent or
  received. `main` reads all messages via `team history`.
- **Board digests**: Unmentioned board posts arrive as a one-line thread digest
  at run start and after tool turns. Digests never wake members, end `team wait`,
  or continue a settling run.
- **Wake rules for stopped members**:
  - Board posts never wake stopped members.
  - Direct messages wake stopped members when sent by `main` or by a member
    whose run was started by `main`.
  - A run woken by another member's direct message (`hop1`) cannot wake stopped
    members.
  - A member aborted by `main` (`locked`) wakes only for `main`.
  - Stuck direct messages stay in the recipient's inbox and send a `team-notice`
    to `main`.
- **Final reply routing**: A run woken by member `X` sends its final reply as a
  direct message to `X` if `X` is still running, or to `main` as a
  `subagent-result` marked `(woken by X; X had stopped)`. Runs started by `main`
  report to `main`. Replies over `16000` chars truncate in the report and write
  in full to `<member dir>/final.md`.

## 4. Session Files and Parent Lifecycle

- **Files**: For `<session>.jsonl`, team records live in `<session>/team.jsonl`
  and member sessions in `<session>/subagents/<name>/` (in-memory parent
  sessions use `<tmpdir>/pi-subagent/<sessionId>/`). On load, an unterminated
  tail line in `team.jsonl` gets a trailing newline before new writes, and
  malformed lines are skipped (with a warning when UI is available).
- **Reopen, fork, and tree navigation**: Reopening a session restores members as
  `stopped`. On `session_start` and `session_tree`, the current branch receives
  missing messages to/from `main` (latest `10` in full, earlier ones counted in
  a notice) and missing member results without starting a turn. `/fork` and
  `/clone` start a new empty team and post a notice about inherited messages.
- **Parent `Esc` and shutdown**: Aborting `main` (`Esc`) suspends auto-triggering
  until `main` runs again. Session shutdown aborts and terminates all running
  child processes.

## 5. Development Checks

`npm test` runs both supported Pi versions in Docker. Select one with
`PI_VERSION=1.4.0 npm test`. For an existing local development installation,
`PI_CLI=/path/to/cli.js bash test/local.sh` drives that CLI directly.
