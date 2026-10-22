# pi-subagent-rpc-extension

Runs named Pi subagents as session-bound `pi --mode rpc` child processes that
coordinate with the main agent and each other through a shared board and direct
messages.

## Requirements and Quickstart

Requires Pi (tested on `1.3.0` and `1.4.0`).

Install into Pi settings so child processes load the extension automatically:

```sh
pi install /path/to/pi-subagent-rpc-extension
```

For a single run with `pi -e /path/to/pi-subagent-rpc-extension`, also pass
`args: ["-e", "/absolute/path/to/pi-subagent-rpc-extension"]` on each
`subagent run`, because child processes do not inherit `-e`.

## Workflow and Example

The extension registers two tools:

- **`subagent`** (`main` only): hires members (`run`), checks progress or
  results (`status`), stops or retires members (`abort`), compacts member
  context (`compact`), and switches member model or thinking level (`switch`).
- **`team`** (`main` and all members): posts to the board or sends direct
  messages (`send`), reads threads or direct messages (`history`), waits for
  messages (`wait`), lists the roster (`members`), and sets the topic (`topic`,
  `main` only).

Example arguments for the main agent's `subagent` tool:

```json
{
  "action": "run",
  "name": "tester",
  "description": "runs tests and reports failures",
  "message": "Run the test suite and report failing cases."
}
```

Use `status` to check progress, `team send` for more work, and `abort` with
`retire: true` to finish with the member.

## Key Constraints

- **Single-level delegation**: Only `main` has `subagent` and can hire members
  (`2–24` lowercase letters, digits, or hyphens, starting with a letter and no
  trailing hyphen; each name is used once per team). Members keep their normal Pi tools
  and receive `team`, but not `subagent`.
- **Safe points vs. immediate interruption**: On a running member, `abort`,
  `compact`, and `switch` default to `when: "next"`, acting after current tool
  calls finish and before the next model request. `when: "now"` interrupts at
  once; on an immediate stop, a started run gets up to `10` seconds to conclude
  after `abort` before its Pi process is terminated.
- **Required `retire` and abort lock**: `subagent abort` requires
  `retire: true | false`. `true` permanently removes the member from the team;
  `false` stops the member and locks it until `main` gives it new work.
- **Wake and reply routing**: Direct messages (`to`) wake stopped members; board
  posts (`to` omitted) never wake. A run started by another member's direct
  message cannot wake stopped members, and its final reply goes to the member
  that woke it (or to `main` if that member stopped).
- **Session-bound, non-sandboxed processes**: Members run as local child
  processes that end with the parent session and share `cwd` by default without
  write isolation. Concurrent Pi processes on the same parent session are
  unsupported.

## Testing and Reference

```sh
npm test
```

Requires Docker and network access. The script runs typechecks, POSIX process
checks, and E2E tests on Pi `1.3.0` and `1.4.0` in temporary containers with
source mounted read-only.

See [`docs/reference.md`](docs/reference.md), [`src/protocol.ts`](src/protocol.ts),
and [`LICENSE`](LICENSE) (MIT).
