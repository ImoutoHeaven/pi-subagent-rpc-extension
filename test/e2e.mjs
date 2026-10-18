// Drives parent `pi --mode rpc` processes that load the extension, against test/fake-llm.mjs.
// Each parent runs through test/sdk-host.mjs, as in an SDK host, so process.argv[1] is not Pi's CLI.
// Started by test/local.sh, which provides the environment.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { REQUESTS_LOG: REQUESTS, WORK_DIR, PI_CLI } = process.env;
const host = fileURLToPath(new URL("sdk-host.mjs", import.meta.url));
/** The PIDs of the processes whose parent is `pid`. */
const childPids = (pid) =>
	(process.platform === "win32"
		? execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`], { encoding: "utf8" })
		: execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
	)
		.split(/\r?\n/)
		.map((row) => row.trim().split(/\s+/).map(Number))
		.filter(([, ppid]) => ppid === pid)
		.map(([child]) => child);
const alive = (pid) => {
	try {
		return process.kill(pid, 0);
	} catch (error) {
		return error.code === "EPERM";
	}
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(predicate, ms = 60_000) {
	for (const end = Date.now() + ms; !predicate(); await sleep(100)) if (Date.now() > end) throw new Error("timed out");
}

const rawText = (m) => (typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join(""));
const text = (m) => rawText(m).trimEnd();
const requests = () =>
	fs
		.readFileSync(REQUESTS, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((body) => body.messages);
const isTeam = (m) => m.role === "user" && rawText(m).startsWith("[team");
/** The first model request whose last message other than team messages starts with `said`. */
const requestFor = (said) =>
	requests().find((body) => {
		const last = body.messages.findLast((m) => !isTeam(m));
		return last.role === "user" && rawText(last).startsWith(said);
	});
/** The model requests of team member `name`, recognized by its preamble. */
const requestsBy = (name) => requests().filter((body) => body.messages.some((m) => m.role === "user" && rawText(m).startsWith(`[team] You are ${name},`)));
const idOf = (text) => text.match(/^\[\w+\] subagent ([a-z][a-z0-9-]*)/)?.[1];
const LIVE =
	/^\[running\] subagent [0-9a-z-]+(?: · \S+)? · turn \d+ · .+ · last event \d+s ago · \d+s(?: · [\d.]+[KM]? in · [\d.]+[KM]? out(?: · [\d.]+[KM]? cached)?(?: · <?\$\d+\.\d\d)?)?(?: · ctx [\d.]+[KM]?\/[\d.]+[KM]? \d+%)?$/m;
// An idle parent gets a message through sendMessage (message_end); a busy one at a turn boundary (entry_appended).
const asMessage = (e) =>
	e.type === "message_end" && e.message?.role === "custom"
		? e.message
		: e.type === "entry_appended" && e.entry?.type === "custom_message"
			? e.entry
			: undefined;
/** The data of the seen marks that parent `p` appended from event index `from`. */
const seenMarks = (p, from = 0) =>
	p.events.slice(from).filter((e) => e.type === "entry_appended" && e.entry?.type === "custom" && e.entry.customType === "team-seen").map((e) => e.entry.data);
/** The description of members whose test does not name one. */
const ROLE = "test member";
// Messages end with a blank line that separates them; assertions compare the text before it.
const trimmed = (m) => m && { ...m, content: m.content.trimEnd() };

function startParent(args) {
	const child = spawn(process.execPath, [host, PI_CLI, "--mode", "rpc", "--model", "fake/fake-model", ...args], { cwd: join(WORK_DIR, "project"), stdio: "pipe" });
	const events = [];
	const listeners = new Set();
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let newline;
		while ((newline = buffer.indexOf("\n")) !== -1) {
			const event = JSON.parse(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			events.push(event);
			for (const listener of listeners) listener();
		}
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const exited = new Promise((done) => child.on("exit", done));

	const waitEvent = (predicate, from = 0, ms = 60_000) =>
		new Promise((resolve, reject) => {
			const check = () => {
				const found = events.slice(from).find(predicate);
				if (!found) return;
				listeners.delete(check);
				clearTimeout(timer);
				resolve(found);
			};
			const timer = setTimeout(() => {
				listeners.delete(check);
				reject(new Error(`timed out waiting for event; stderr: ${stderr.slice(-500)}`));
			}, ms);
			listeners.add(check);
			check();
		});
	const send = (record) => child.stdin.write(`${JSON.stringify(record)}\n`);
	// followUp: a delivered message may have started a parent turn.
	const prompt = (message) => send({ type: "prompt", message, streamingBehavior: "followUp" });
	/** A model-issued call of the subagent or team tool; `run` gets a default description. */
	const call = async (args, tool = "subagent") => {
		const from = events.length;
		prompt(`${tool === "team" ? "TEAM" : "CALL"} ${JSON.stringify(tool === "subagent" && args.action === "run" ? { description: ROLE, ...args } : args)}`);
		const end = await waitEvent((e) => e.type === "tool_execution_end" && e.toolName === tool, from);
		await waitEvent((e) => e.type === "agent_settled", events.indexOf(end));
		return { text: end.result.content.map((c) => c.text).join(""), isError: end.isError };
	};
	/** The parent model's reply to `message`. */
	const say = async (message) => {
		const from = events.length;
		prompt(message);
		const settled = await waitEvent((e) => e.type === "agent_settled", from);
		return events.slice(from, events.indexOf(settled)).findLast((e) => e.type === "message_end" && e.message.role === "assistant").message.content.map((c) => c.text ?? "").join("");
	};
	const request = async (record) => {
		const id = `req-${events.length}`;
		const from = events.length;
		send({ ...record, id });
		return waitEvent((e) => e.type === "response" && e.id === id, from);
	};
	/** Subagent and team messages delivered from event index `from`. */
	const messages = (from = 0) =>
		events
			.slice(from)
			.map(asMessage)
			.filter((m) => m?.customType?.startsWith("subagent-") || m?.customType?.startsWith("team-"))
			.map(trimmed);
	/** The first message of `customType` from event index `from`, with `at`, its event index. */
	const waitMessage = (customType, from, ms) =>
		waitEvent((e) => asMessage(e)?.customType === customType, from, ms).then((e) => ({ ...trimmed(asMessage(e)), at: events.indexOf(e) }));
	const close = async () => {
		child.stdin.end();
		await exited;
	};
	return { child, events, waitEvent, send, prompt, call, say, request, messages, waitMessage, close };
}

let failed = 0;
let current;
async function step(name, fn) {
	if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
	try {
		await fn();
		console.log(`PASS  ${name}`);
	} catch (error) {
		failed++;
		console.log(`FAIL  ${name}\n      ${String(error.stack || error).split("\n").slice(0, 6).join("\n      ")}`);
		const recent = (current?.events ?? []).slice(-8).map((e) => JSON.stringify(e).slice(0, 300));
		console.log(`      recent events:\n        ${recent.join("\n        ")}`);
	}
}

const parent = startParent(["--session-dir", join(WORK_DIR, "sessions")]);
current = parent;
const { events, send, call, waitEvent, waitMessage } = parent;
const notifications = (from = 0) => parent.messages(from).filter((m) => m.customType === "subagent-result");

let first;
await step("run returns the result when the child finishes within waitMs", async () => {
	const r = await call({ action: "run", name: "first", message: "SAY hello" });
	// One reply of 500 uncached and 1000 cached prompt tokens and 200 completion tokens, at the test model's price;
	// its 1700 context tokens against the compact point of Pi's default 128000-token window and 16384 reserve tokens.
	assert.match(r.text, /^\[settled\] subagent first · fake\/fake-model:off · 1 turns · \d+s · 500 in · 200 out · 1K cached · \$0\.26 · ctx 1\.7K\/111\.6K 2%\n/);
	assert.match(r.text, /hello$/);
	assert.doesNotMatch(r.text, /\(Background:/);
	first = idOf(r.text);
	// A later call does not repeat a returned result.
	const again = await call({ action: "status", id: first });
	assert.match(again.text, /^\[settled\] subagent first.*\n\nIts result was returned to you earlier\. Full reply: .*final\.md$/s);
	assert.doesNotMatch(again.text, /hello/);
});

await step("children run the default model and get the team tool instead of the subagent tool; the main agent has both", async () => {
	const r = await call({ action: "run", name: "tools", message: "TOOLS?" });
	const tools = r.text.match(/^tools: (.*)$/m)?.[1].split(",");
	assert.ok(tools?.includes("read"), r.text);
	assert.ok(tools.includes("team") && !tools.includes("subagent"), r.text);
	assert.equal(requestFor("TOOLS?").model, "fake-model");
	assert.ok(!requestFor("SAY hello").messages.some((m) => m.tool_calls), "a child saw parent history");
	const own = (await parent.say("TOOLS?")).replace(/^tools: /, "").split(",");
	assert.ok(own.includes("subagent") && own.includes("team"), own.join(","));
});

await step("status without id lists subagents", async () => {
	const r = await call({ action: "status" });
	assert.match(r.text, new RegExp(`\\[settled\\] subagent ${first}`));
});

await step("a direct message from the main agent wakes a stopped member in its own session; its result reaches the main agent", async () => {
	const from = events.length;
	const sent = await call({ action: "send", to: first, body: "SAY again" }, "team");
	assert.match(sent.text, /^Sent #\d+ to first \(woken\)\.$/);
	const note = await waitMessage("subagent-result", from);
	assert.match(note.content, /^\[settled\] subagent first.*again$/s);
	await waitEvent((e) => e.type === "agent_settled", note.at);
	const woken = requestsBy("first").at(-1).messages;
	assert.ok(woken.some((m) => m.role === "user" && rawText(m).startsWith("SAY hello")), "session history missing");
	assert.equal(rawText(woken.findLast((m) => m.role === "user" && !isTeam(m))), "The main agent sent you a team message. Act on your team messages.");
});

await step("a result that outlives waitMs arrives once as a message that starts a turn", async () => {
	const r = await call({ action: "run", name: "slow", message: "SLOW 2000 SAY late", waitMs: 300 });
	assert.match(r.text, LIVE);
	const id = idOf(r.text);
	const from = events.length;
	const note = await waitMessage("subagent-result", from);
	assert.match(note.content, new RegExp(`^\\[settled\\] subagent ${id}.*late$`, "s"));
	await waitEvent((e) => e.type === "agent_settled", from);
	assert.equal(notifications(from).length, 1);
	assert.ok(requestFor("[settled]"), "notification did not reach the model");
	// Asking afterwards does not repeat the result.
	const again = await call({ action: "status", id });
	assert.match(again.text, /^\[settled\].*sent to you as a subagent-result message\. Full reply: .*final\.md$/s);
	assert.doesNotMatch(again.text, /late/);
});

await step("progress shows each running tool with a one-line summary of its arguments", async () => {
	const from = events.length;
	await call({ action: "run", name: "sleeper", message: "BASH sleep 4 && echo slept", waitMs: 0 });
	let progress = "";
	for (const end = Date.now() + 30_000; !progress.includes(" · bash (") && Date.now() < end; ) progress = (await call({ action: "status", id: "sleeper", waitMs: 500 })).text;
	assert.match(progress, LIVE);
	assert.match(progress, /^\[running\] subagent sleeper(?: · \S+)? · turn 1 · bash \(sleep 4 && echo slept\) \d+s · last event /);
	const result = await waitEvent((e) => asMessage(e)?.customType === "subagent-result" && asMessage(e).details?.id === "sleeper", from);
	await waitEvent((e) => e.type === "agent_settled", events.indexOf(result));
});

const finalFile = (id) =>
	fs.readdirSync(join(WORK_DIR, "sessions"), { recursive: true }).some((p) => String(p).replaceAll("\\", "/").endsWith(`subagents/${id}/final.md`));

await step("results that reach a busy parent arrive together right after its current tool calls", async () => {
	const from = events.length;
	const ids = [];
	for (const n of [1, 2]) ids.push(idOf((await call({ action: "run", name: `busy${n}`, message: `SLOW 4000 SAY busy${n}`, waitMs: 0 })).text));
	const mark = events.length;
	send({ type: "prompt", streamingBehavior: "followUp", message: `CALLS 15000 ${JSON.stringify({ action: "run", name: "busy3", description: ROLE, message: "SLOW 1000 SAY busy3", waitMs: 0 })} || ${JSON.stringify({ action: "status" })}` });
	const started = await waitEvent((e) => e.type === "tool_execution_end" && e.toolName === "subagent", mark);
	ids.push(idOf(started.result.content[0].text));
	await waitEvent((e) => e.type === "agent_settled", events.indexOf(started));
	assert.equal(notifications(from).length, 3);
	// All three in the first model request that has any of them, right after the status tool result.
	const result = (n) => (m) => m.role === "user" && /^\[settled\] subagent [\s\S]*\n\nbusy\d$/.test(text(m)) && text(m).endsWith(`busy${n}`);
	const seen = requests()
		.map((body) => body.messages)
		.find((messages) => [1, 2, 3].some((n) => messages.some(result(n))));
	assert.equal(seen.at(-4).role, "tool");
	// Each ends with a blank line, so the joined messages stay apart.
	for (const m of seen.slice(-3)) assert.ok(rawText(m).endsWith("\n\n"), JSON.stringify(rawText(m)));
	for (const n of [1, 2, 3]) assert.ok(seen.slice(-3).some(result(n)), `busy${n} is not in the same request`);
});

await step("a tool wait ends early when another subagent sends a message", async () => {
	const hung = idOf((await call({ action: "run", name: "hung", message: "HANG", waitMs: 0 })).text);
	const from = events.length;
	await call({ action: "run", name: "pinger", message: `SLOW 2000 TEAM ${JSON.stringify({ action: "send", to: "main", body: "ping" })}`, waitMs: 0 });
	const started = Date.now();
	const s = await call({ action: "status", id: hung, waitMs: 60_000 });
	assert.ok(Date.now() - started < 30_000, "the wait was not cut short");
	assert.match(s.text, /Returned early: subagent messages follow this result\./);
	assert.ok(parent.messages(from).some((m) => m.customType === "team-message" && /\nping$/.test(m.content)));
	await call({ action: "abort", id: hung, retire: false, when: "now" });
});

await step("a result queued in a turn stopped with Esc is kept without waking the parent", async () => {
	const from = events.length;
	send({ type: "prompt", streamingBehavior: "followUp", message: `CALL ${JSON.stringify({ action: "run", name: "esc", description: ROLE, message: "SAY esc", waitMs: 0 })} HOLD` });
	const started = await waitEvent((e) => e.type === "tool_execution_end" && e.toolName === "subagent", from);
	const id = idOf(started.result.content[0].text);
	await until(() => finalFile(id));
	await sleep(300);
	// What interactive Esc does.
	send({ type: "clear_queue" });
	send({ type: "abort" });
	const settled = await waitEvent((e) => e.type === "agent_settled", events.indexOf(started));
	assert.equal(settled.aborted, true);
	const note = await waitMessage("subagent-result", from, 5000);
	assert.match(note.content, new RegExp(`^\\[settled\\] subagent ${id}.*esc$`, "s"));
	await sleep(2000);
	assert.equal(notifications(from).length, 1);
	assert.ok(!events.slice(events.indexOf(settled)).some((e) => e.type === "agent_start"), "the parent was woken");
});

await step("after Esc, a later result does not start a turn; the next prompt ends that", async () => {
	const from = events.length;
	send({ type: "prompt", streamingBehavior: "followUp", message: `CALL ${JSON.stringify({ action: "run", name: "after-esc", description: ROLE, message: "SLOW 3000 SAY after esc", waitMs: 0 })} HOLD` });
	const started = await waitEvent((e) => e.type === "tool_execution_end" && e.toolName === "subagent", from);
	await sleep(300);
	send({ type: "clear_queue" });
	send({ type: "abort" });
	const settled = await waitEvent((e) => e.type === "agent_settled", events.indexOf(started));
	assert.equal(settled.aborted, true);
	const note = await waitMessage("subagent-result", events.indexOf(settled), 30_000);
	assert.match(note.content, /after esc$/);
	await sleep(2000);
	assert.ok(!events.slice(events.indexOf(settled)).some((e) => e.type === "agent_start"), "the parent was woken");
	// A prompt from the user lets later results start turns again.
	await call({ action: "run", name: "woken", message: "SLOW 2000 SAY woken", waitMs: 0 });
	const mark = events.length;
	await waitMessage("subagent-result", mark);
	await waitEvent((e) => e.type === "agent_start", mark);
	await waitEvent((e) => e.type === "agent_settled", mark);
});

for (const aborted of [true, false]) {
	await step(`a result arriving during an earlier settle handler ${aborted ? "does not undo Esc" : "still wakes a normally settled parent"}`, async () => {
		const member = aborted ? "settle-aborted" : "settle-normal";
		const gate = join(WORK_DIR, `settle-${aborted}`);
		const extension = `${gate}.ts`;
		fs.writeFileSync(extension, `import { existsSync } from "node:fs";
export default function (pi) {
	let held = false;
	const wait = async (path) => { while (!existsSync(path)) await new Promise((done) => setTimeout(done, 20)); };
	pi.on("before_agent_start", async (event) => {
		if (event.prompt === "SAY settle-result") await wait(${JSON.stringify(`${gate}-child`)});
		if (event.prompt === "HANG" || event.prompt === "SAY settle-parent") held = true;
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (!held) return;
		held = false;
		ctx.ui.notify("settle held", "info");
		await wait(${JSON.stringify(`${gate}-parent`)});
	});
}
`);
		// The fixture's awaited handler runs before the subagent extension's suspension update.
		const p = startParent(["--session-dir", join(WORK_DIR, `settle-sessions-${aborted}`), "--no-extensions", "-e", extension, "-e", fileURLToPath(new URL("..", import.meta.url))]);
		current = p;
		try {
			await p.call({ action: "run", name: member, message: "SAY settle-result", args: ["-e", extension], waitMs: 0 });
			const { sessionFile } = (await p.request({ type: "get_state" })).data;
			const final = join(sessionFile.replace(/\.jsonl$/, ""), "subagents", member, "final.md");
			const from = p.events.length;
			p.prompt(aborted ? "HANG" : "SAY settle-parent");
			await p.waitEvent((e) => e.type === "agent_start", from);
			const stop = aborted ? p.request({ type: "abort" }) : undefined;
			await p.waitEvent((e) => e.type === "extension_ui_request" && e.message === "settle held", from);
			fs.writeFileSync(`${gate}-child`, "");
			await until(() => fs.existsSync(final));
			// The parent wrote the final reply; let its completion callback finish before releasing settlement.
			await p.request({ type: "get_state" });
			fs.writeFileSync(`${gate}-parent`, "");
			const settled = await p.waitEvent((e) => e.type === "agent_settled", from);
			assert.equal(settled.aborted, aborted);
			if (!aborted) {
				const started = await p.waitEvent((e) => e.type === "agent_start", p.events.indexOf(settled) + 1);
				await p.waitEvent((e) => e.type === "agent_settled", p.events.indexOf(started));
			}
			// RPC abort responds after Pi is idle, including any wrongly restarted run.
			if (stop) assert.equal((await stop).success, true);
			assert.equal(p.events.slice(from).filter((e) => e.type === "agent_start").length, aborted ? 1 : 2);
			const { entries } = (await p.request({ type: "get_entries" })).data;
			const results = entries.filter((e) => e.type === "custom_message" && e.customType === "subagent-result" && e.details?.id === member);
			assert.equal(results.length, 1);
			assert.match(results[0].content, /settle-result\s*$/);
		} finally {
			fs.writeFileSync(`${gate}-child`, "");
			fs.writeFileSync(`${gate}-parent`, "");
			await p.close();
		}
	});
}

await step("a result returned by a call is not delivered again", async () => {
	const from = events.length;
	const r = await call({ action: "run", name: "quick", message: "SLOW 300 SAY quick", waitMs: 10_000 });
	assert.match(r.text, /quick$/);
	await sleep(1500);
	assert.equal(notifications(from).length, 0);
});

await step("abort requires retire; with retire false, it stops a hung child, which other results show in their footer until then", async () => {
	const r = await call({ action: "run", name: "hanging", message: "HANG", waitMs: 500 });
	assert.match(r.text, LIVE);
	const id = idOf(r.text);
	const other = await call({ action: "run", name: "side", message: "SAY side" });
	assert.match(other.text, new RegExp(`side\\n\\n\\(Background: ${id} running \\d+s\\.\\)$`));
	const missing = await call({ action: "abort", id });
	assert.ok(missing.isError, missing.text);
	assert.match(missing.text, /abort requires retire: true or false/);
	const a = await call({ action: "abort", id, retire: false, when: "now" });
	assert.match(a.text, /^\[aborted\]/);
	assert.doesNotMatch(a.text, /Background/);
});

await step("a child stays a subagent when its extensions reload", async () => {
	const reloader = join(WORK_DIR, "reload-extension.ts");
	// The tool reloads the child's extensions mid-run; the model's next request lists the tools after the reload.
	fs.writeFileSync(
		reloader,
		`export default function (pi) {
	pi.registerCommand("reload-now", { handler: (_args, ctx) => ctx.reload() });
	pi.registerTool({ name: "reload_now", label: "Reload", description: "Reloads extensions.", parameters: { type: "object", properties: {} },
		async execute() {
			await pi.sendUserMessage("/reload-now", { expandPromptTemplates: true });
			return { content: [{ type: "text", text: "reloaded" }], details: undefined };
		} });
}
`,
	);
	const r = await call({ action: "run", name: "reloaded", message: "RELOAD", args: ["-e", reloader], waitMs: 30_000 });
	const tools = r.text.match(/^tools: (.*)$/m)?.[1].split(",");
	assert.ok(tools?.includes("team") && !tools.includes("subagent"), r.text);
});

await step("a child that cannot start reports an error with Pi's output", async () => {
	const r = await call({ action: "run", name: "broken", message: "SAY x", args: ["-z"], waitMs: 30_000 });
	assert.match(r.text, /^\[error\] subagent broken · 0 turns/);
	assert.match(r.text, /Pi exited \(code [1-9]/);
	assert.match(r.text, /-z/);
});

await step("owned flags and unknown ids are rejected", async () => {
	const bad = await call({ action: "run", name: "owned", message: "SAY x", args: ["--session-dir=/tmp/x"] });
	assert.ok(bad.isError);
	assert.match(bad.text, /must not include --session-dir=/);
	for (const flag of ["--thinking", "--provider"]) {
		const owned = await call({ action: "run", name: "owned", message: "SAY x", args: [flag, "x"] });
		assert.ok(owned.isError, owned.text);
		assert.match(owned.text, new RegExp(`must not include ${flag};`));
	}
	const unknown = await call({ action: "status", id: "zzzzzz" });
	assert.ok(unknown.isError);
	assert.match(unknown.text, /Unknown subagent id/);
});

await step("subagent has no steer or follow_up action", async () => {
	for (const action of ["steer", "follow_up"]) {
		const r = await call({ action, id: first, message: "SAY x" });
		assert.ok(r.isError, r.text);
		assert.match(r.text, /action/);
	}
});

await step("children end with the parent session", async () => {
	await call({ action: "run", name: "last", message: "HANG", waitMs: 300 });
	const children = childPids(parent.child.pid);
	assert.ok(children.length > 0, "no child process found");
	await parent.close();
	await sleep(5000);
	assert.deepEqual(children.filter(alive), []);
});

await step("a session without a session file hires members", async () => {
	const bare = startParent(["--no-session"]);
	current = bare;
	try {
		assert.match((await bare.call({ action: "run", name: "solo", message: "SAY solo" })).text, /^\[settled\] subagent solo.*solo$/s);
	} finally {
		await bare.close();
	}
});

const busyExtension = join(WORK_DIR, "busy-extension.ts");
fs.writeFileSync(
	busyExtension,
	`export default function (pi) {
	// Loaded after the subagent extension, so compaction stays busy after that extension's handler ran.
	pi.on("session_compact", () => new Promise((done) => setTimeout(done, 1000)));
	pi.registerCommand("tree-now", { handler: async (_args, ctx) => {
		const first = ctx.sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "user");
		await ctx.navigateTree(first.id, { summarize: true, customInstructions: "SLOW 8000" });
		ctx.ui.notify("navigated", "info");
	} });
	pi.registerCommand("tree-back", { handler: async (_args, ctx) => {
		const digest = ctx.sessionManager.getBranch().findLast((e) => e.type === "custom_message" && e.customType === "team-notice");
		await ctx.navigateTree(digest.parentId, { summarize: false });
		ctx.ui.notify("navigated back", "info");
	} });
	// "<id> [ms]": with ms, the abandoned branch is summarized after ms.
	pi.registerCommand("tree-to", { handler: async (args, ctx) => {
		const [id, ms] = args.trim().split(" ");
		await ctx.navigateTree(id, ms ? { summarize: true, customInstructions: \`SLOW \${ms}\` } : { summarize: false });
		ctx.ui.notify(\`navigated to \${id}\`, "info");
	} });
	// Appends the custom message that the JSON argument describes.
	pi.registerCommand("deliver", { handler: async (args, ctx) => {
		pi.sendMessage(JSON.parse(args), { triggerTurn: false });
		ctx.ui.notify("delivered", "info");
	} });
	// Holds this prompt's start after the subagent extension's handler ran.
	pi.on("before_agent_start", (event) => (event.prompt === "SAY preflight" ? new Promise((done) => setTimeout(done, 6000)) : undefined));
}
`,
);
/**
 * A result that arrives while an idle parent is busy outside a run, from `busy` until the event `done` matches,
 * wakes the parent afterwards. Returns that event.
 */
const wakesAfter = async (busy, done) => {
	// Pi loads -e extensions in order, ahead of those from settings.
	const idle = startParent(["--session-dir", join(WORK_DIR, "sessions"), "--no-extensions", "-e", fileURLToPath(new URL("..", import.meta.url)), "-e", busyExtension]);
	current = idle;
	try {
		await idle.say("SAY before");
		// Past Pi's 20000 kept tokens, so compaction summarizes the message before it.
		await idle.say("x".repeat(100_000));
		const id = idOf((await idle.call({ action: "run", name: "late", message: "SLOW 3000 SAY late", waitMs: 0 })).text);
		const from = idle.events.length;
		busy(idle);
		const queued = await idle.waitEvent((e) => e.type === "extension_ui_request" && e.message === `subagent ${id}: result waiting for the main agent`, from);
		const ended = await idle.waitEvent(done, from);
		const end = idle.events.indexOf(ended);
		assert.ok(idle.events.indexOf(queued) < end, "the result came after the parent was done");
		const note = await idle.waitMessage("subagent-result", end, 5000);
		assert.match(note.content, /late$/);
		await idle.waitEvent((e) => e.type === "agent_start", end);
		await idle.waitEvent((e) => e.type === "agent_settled", end);
		return ended;
	} finally {
		await idle.close();
	}
};

await step("a result that arrives while an idle parent compacts wakes it when compaction ends", async () => {
	const ended = await wakesAfter(
		(idle) => idle.send({ type: "compact", customInstructions: "SLOW 8000" }),
		(e) => e.type === "compaction_end",
	);
	assert.ok(ended.result, ended.errorMessage);
});

await step("a result that arrives while an idle parent summarizes a tree branch wakes it when navigation ends", async () => {
	await wakesAfter(
		(idle) => idle.prompt("/tree-now"),
		(e) => e.type === "extension_ui_request" && e.message === "navigated",
	);
});

await step("after the main agent moves back in the session tree past a digest, the next digest lists those posts again", async () => {
	const back = startParent(["--session-dir", join(WORK_DIR, "sessions"), "--no-extensions", "-e", fileURLToPath(new URL("..", import.meta.url)), "-e", busyExtension]);
	current = back;
	const digests = (from) => back.messages(from).filter((m) => m.customType === "team-notice").map((m) => m.content);
	try {
		let from = back.events.length;
		const r = await back.call({ action: "run", name: "sierra", message: `TEAM ${JSON.stringify({ action: "send", title: "sierra news", body: "sierra news" })}` });
		const digest = `[team] Board: 1 new post — #${r.text.match(/team: Posted #(\d+)\./)[1]} sierra: sierra news (team history).`;
		assert.deepEqual(digests(from), [digest]);
		from = back.events.length;
		back.prompt("/tree-back");
		await back.waitEvent((e) => e.type === "extension_ui_request" && e.message === "navigated back", from);
		from = back.events.length;
		await back.call({ action: "members" }, "team");
		assert.deepEqual(digests(from), [digest]);
	} finally {
		await back.close();
	}
});

const team = startParent(["--session-dir", join(WORK_DIR, "team-sessions")]);
current = team;
const run = (args) => team.call({ action: "run", ...args });
const teamCall = (args) => team.call(args, "team");
const TEAM = (args) => `TEAM ${JSON.stringify(args)}`;
const TEAMS = (steps) => `TEAMS ${steps.map((args) => JSON.stringify(args)).join(" || ")}`;
/** Waits until member `id` has finished its run and returns the last status text; a status call returns early when other results arrive. */
const finished = async (id) => {
	for (let i = 0; i < 10; i++) {
		const status = (await team.call({ action: "status", id, waitMs: 30_000 })).text;
		if (!status.startsWith("[running]")) return status;
	}
	throw new Error(`${id} did not finish`);
};
/**
 * Member `id`'s final report on its run after event index `from`. A member can finish before a status call starts
 * waiting; its result then arrives as a subagent-result message instead.
 */
const report = async (id, from) => {
	const status = await finished(id);
	if (!status.includes("Its result was sent to you as a subagent-result message.")) return status;
	const note = await team.waitEvent((e) => asMessage(e)?.customType === "subagent-result" && asMessage(e).details?.id === id, from);
	return trimmed(asMessage(note)).content;
};

await step("run requires a valid name, a one-line description, and args that keep the team tool", async () => {
	for (const [args, error] of [
		[{ message: "SAY x" }, /requires name/],
		[{ name: "nodesc", description: undefined, message: "SAY x" }, /requires description/],
		[{ name: "nodesc", description: "  ", message: "SAY x" }, /requires description/],
		[{ name: "nodesc", description: "x".repeat(101), message: "SAY x" }, /description is 101 characters, over 100/],
		[{ name: "nodesc", description: "two\nlines", message: "SAY x" }, /one line of at most 100 characters/],
		[{ name: "toolless", args: ["--tools", "read"], message: "SAY x" }, /remove the team tool/],
		[{ name: "main", message: "SAY x" }, /reserved/],
		[{ name: "Bad_Name", message: "SAY x" }, /name must match/],
	]) {
		const r = await run(args);
		assert.ok(r.isError, r.text);
		assert.match(r.text, error);
	}
});

await step("a mention reaches a running member's next request and does not wake a stopped one; a direct message from the main agent does", async () => {
	const beta = await run({ name: "beta", description: "answers as beta", message: "SAY beta here" });
	assert.match(beta.text, /^\[settled\] subagent beta · fake\/fake-model:off · 1 turns/);
	const children = requestsBy("beta").length;
	const typo = await teamCall({ action: "send", title: "x", body: "x", mentions: ["all", "typo"] });
	assert.ok(typo.isError);
	assert.match(typo.text, /Unknown member: typo/);
	const alpha = await run({ name: "alpha", description: "lists the team", message: `SLOW 3000 ${TEAM({ action: "members" })}`, waitMs: 0 });
	assert.match(alpha.text, LIVE);
	await until(() => requestsBy("alpha").length > 0);
	const preamble = requestsBy("alpha")[0].messages.find((m) => rawText(m).startsWith("[team] You are alpha,"));
	assert.match(rawText(preamble), /\n- main: main agent\n- beta: stopped — answers as beta\n- alpha: running — lists the team\n/);
	assert.match(
		rawText(preamble),
		/\nUse team send to hand results to whoever needs them and to coordinate\. In this run, your direct messages wake stopped members, each for a full run; post news that can wait on the board with a title, mentioning them, and they read it in full when they next run\.\nSend a message only when it gives its recipients something they need: a result, a question, a decision, or a blocker\. Do not send messages that only acknowledge or repeat what they already have\.\nCheck what team send returns: if a recipient was not woken, say so in your final reply\.\n/,
	);
	assert.match(rawText(preamble), /\nYour final reply goes to main\. Keep it short: for what you already sent with team send, name the #seq instead of repeating it\.\n\n/);
	const sent = await teamCall({ action: "send", title: "hello both", body: "hello both", mentions: ["alpha", "beta"] });
	assert.match(sent.text, /^Sent #\d+ to alpha \(running\), beta \(stopped; board posts do not wake\)\.$/);
	const done = await team.call({ action: "status", id: "alpha", waitMs: 30_000 });
	assert.match(done.text, /^\[settled\] subagent alpha.*team: Members:\n- main: main agent\n- beta: stopped — answers as beta\n- alpha: running — lists the team\n/s);
	assert.equal((await teamCall({ action: "members" })).text, "Members:\n- main: main agent\n- beta: stopped — answers as beta\n- alpha: stopped — lists the team\nTopic: (none)");
	const next = requestsBy("alpha").at(-1).messages;
	assert.equal(next.at(-2).role, "tool");
	assert.match(text(next.at(-1)), /^\[team #\d+\] main → #team, mentions you, beta: hello both\nhello both$/);
	await sleep(1000);
	assert.equal(requestsBy("beta").length, children, "a board post woke a stopped member");
	const mark = team.events.length;
	const woke = await teamCall({ action: "send", to: "beta", body: "SAY beta again" });
	assert.match(woke.text, /^Sent #\d+ to beta \(woken\)\.$/);
	assert.match(await report("beta", mark), /beta again$/);
	const start = requestsBy("beta").at(-1).messages.at(-1);
	// alpha joined after beta's first run, so beta's digest holds alpha's join announcement.
	assert.match(
		text(start),
		/^\[team\] You are beta,[\s\S]*\[team #\d+\] main → #team, mentions alpha, you: hello both\nhello both\n\n\[team #\d+\] main → you \(direct\):\nSAY beta again\n\n\[team\] Board: 1 new post — #\d+ main: joined: alpha — lists the team \(team history\)\.$/,
	);
	const again = await run({ name: "beta", message: "SAY x" });
	assert.ok(again.isError);
	assert.match(again.text, /beta is already a member; send it a direct message with team send/);
});

await step("a direct message between two members is invisible to a third member; the main agent reads it", async () => {
	await run({ name: "eve", message: TEAM({ action: "wait", ms: 60_000 }), waitMs: 0 });
	await until(() => requestsBy("eve").length > 0);
	await run({ name: "carol", message: TEAM({ action: "send", to: "eve", body: "secret plan" }), waitMs: 0 });
	for (const id of ["carol", "eve"]) await finished(id);
	const sent = requestsBy("carol").at(-1).messages.findLast((m) => m.role === "tool");
	assert.match(rawText(sent), /^Sent #\d+ to eve \(running\)\.$/);
	const board = await run({ name: "gamma", message: TEAM({ action: "history" }) });
	assert.match(board.text, /hello both/);
	assert.doesNotMatch(board.text, /secret plan/);
	let mark = team.events.length;
	await teamCall({ action: "send", to: "gamma", body: TEAM({ action: "history", with: "carol" }) });
	assert.match(await report("gamma", mark), /team: No messages\.$/);
	mark = team.events.length;
	await teamCall({ action: "send", to: "eve", body: TEAM({ action: "history", with: "carol", query: "SECRET" }) });
	assert.match(await report("eve", mark), /\[team #\d+\] carol → you \(direct\):\nsecret plan$/);
	const main = await teamCall({ action: "history", with: "carol" });
	assert.match(main.text, /^\[team #\d+\] carol → eve \(direct\):\nsecret plan$/);
});

await step("a direct message to several members is one message that each gets and wakes; only its participants see it", async () => {
	await run({ name: "ann", message: TEAM({ action: "wait", ms: 60_000 }), waitMs: 0 });
	await until(() => requestsBy("ann").length > 0);
	await run({ name: "bob", message: "SAY bob ready" });
	let mark = team.events.length;
	const sent = await teamCall({ action: "send", to: ["ann", "bob"], body: "SAY to both" });
	const seq = sent.text.match(/^Sent #(\d+) to ann \(running\), bob \(woken\)\.$/)?.[1] ?? assert.fail(sent.text);
	assert.match(await report("bob", mark), /to both$/);
	assert.match(rawText(requestsBy("bob").at(-1).messages.at(-1)), new RegExp(`\\[team #${seq}\\] main → ann, you \\(direct\\):\\nSAY to both\\n`));
	await finished("ann");
	assert.ok(requestsBy("ann").at(-1).messages.some((m) => text(m) === `[team #${seq}] main → you, bob (direct):\nSAY to both`), "ann did not get it");
	assert.equal((await teamCall({ action: "history", with: "ann" })).text, `[team #${seq}] you → ann, bob (direct):\nSAY to both`);
	// A recipient reads it with the other recipient; a member outside it does not.
	mark = team.events.length;
	await teamCall({ action: "send", to: "bob", body: TEAM({ action: "history", with: "ann" }) });
	assert.match(await report("bob", mark), new RegExp(`team: \\[team #${seq}\\] main → ann, you \\(direct\\):\\nSAY to both$`));
	assert.match((await run({ name: "cid", message: TEAM({ action: "history", with: "ann" }) })).text, /team: No messages\.$/);
});

await step("a direct reply to a member's direct message also goes to its author, who reads it in history", async () => {
	const from = team.events.length;
	await run({ name: "dot", message: TEAM({ action: "send", to: "main", body: "question for main" }) });
	const asked = (await team.waitMessage("team-message", from)).details.seq;
	// run returns early when dot's message arrives.
	await finished("dot");
	let mark = team.events.length;
	const sent = await teamCall({ action: "send", to: ["ann"], replyTo: asked, body: "SAY answered" });
	const seq = sent.text.match(/^Sent #(\d+) to ann \(woken\), dot \(woken\)\.$/)?.[1] ?? assert.fail(sent.text);
	const reply = (viewer) => `[team #${seq}] ${viewer} → ann, dot (direct), replying to #${asked}:\nSAY answered`;
	for (const id of ["ann", "dot"]) assert.match(await report(id, mark), /\n\nanswered(\n\n\(Background: .*\))?$/);
	assert.ok((await teamCall({ action: "history", with: "dot" })).text.includes(reply("you")), "main's history lacks the reply");
	mark = team.events.length;
	await teamCall({ action: "send", to: "dot", body: TEAM({ action: "history", with: "main" }) });
	assert.ok((await report("dot", mark)).includes(reply("main").replace("dot (direct)", "you (direct)")), "dot's history lacks the reply");
});

await step("a direct message names each recipient once, never its sender, and only members", async () => {
	for (const [to, error] of [
		[[], /to names at least one recipient/],
		[["ann", "ann"], /to names ann twice/],
		[["ann", "main"], /you cannot send a message to yourself/],
		[["ann", "nobody"], /Unknown member: nobody/],
		[["all"], /Unknown member: all/],
	]) {
		const r = await teamCall({ action: "send", to, body: "x" });
		assert.ok(r.isError, r.text);
		assert.match(r.text, error);
	}
});

await step("a board post requires a one-line title of at most 100 characters; a direct message and a reply take none", async () => {
	for (const [params, error] of [
		[{ body: "x" }, /a board post requires title: one line of at most 100 characters/],
		[{ title: " ", body: "x" }, /a board post requires title: one line of at most 100 characters/],
		[{ title: "two\nlines", body: "x" }, /title must be one line of at most 100 characters/],
		[{ title: "t".repeat(101), body: "x" }, /title is 101 characters, over 100; put the details in the body/],
		[{ to: "ann", title: "x", body: "x" }, /title applies to board posts; a direct message has only a body/],
		[{ title: "x", body: "x", replyTo: 1 }, /title names a thread; a reply has only a body/],
		[{ to: "ann", title: "x", body: "x", replyTo: 1 }, /title names a thread; a reply has only a body/],
	]) {
		const r = await teamCall({ action: "send", ...params });
		assert.ok(r.isError, r.text);
		assert.match(r.text, error);
	}
});

await step("a direct message can answer a board post and also goes to its author; a board post cannot answer a direct message", async () => {
	const posted = await run({ name: "asker", message: TEAM({ action: "send", title: "Who takes the parser?", body: "The parser needs an owner." }) });
	const post = posted.text.match(/team: Posted #(\d+)\./)?.[1] ?? assert.fail(posted.text);
	const mark = team.events.length;
	const sent = await teamCall({ action: "send", to: "ann", replyTo: Number(post), body: "SAY taken" });
	const seq = sent.text.match(/^Sent #(\d+) to ann \(woken\), asker \(woken\)\.$/)?.[1] ?? assert.fail(sent.text);
	for (const id of ["ann", "asker"]) assert.match(await report(id, mark), /taken/);
	assert.match(rawText(requestsBy("asker").at(-1).messages.at(-1)), new RegExp(`\\[team #${seq}\\] main → ann, you \\(direct\\), replying to #${post} "Who takes the parser\\?":\\nSAY taken\\n`));
	assert.match((await teamCall({ action: "history" })).text, new RegExp(`\\[team #${post}\\] asker → #team: Who takes the parser\\?\\nThe parser needs an owner\\.`));
	const r = await teamCall({ action: "send", body: "x", replyTo: Number(seq) });
	assert.ok(r.isError, r.text);
	assert.equal(r.text, `#${seq} is a direct message; a board post replies only to a board post, so answer it with to`);
});

await step("a message that arrives while a member writes its final reply continues the same run", async () => {
	await run({ name: "settler", message: "SLOW 3000 SAY first answer", waitMs: 0 });
	await until(() => requestsBy("settler").length > 0);
	const sent = await teamCall({ action: "send", to: "settler", body: "late news" });
	assert.match(sent.text, /^Sent #\d+ to settler \(running\)\.$/);
	const done = await team.call({ action: "status", id: "settler", waitMs: 30_000 });
	// The usage of both replies of the run.
	assert.match(done.text, /^\[settled\] subagent settler · fake\/fake-model:off · 2 turns · \d+s · 1K in · 400 out · 2K cached · \$0\.52 · ctx 1\.7K\/111\.6K 2%\n.*notified$/s);
	const last = requestsBy("settler").at(-1).messages;
	assert.equal(text(last.at(-2)), "first answer");
	assert.match(text(last.at(-1)), /^\[team #\d+\] main → you \(direct\):\nlate news$/);
});

await step("a member's direct message wakes a stopped member, whose final reply goes back to it as a team message", async () => {
	const from = team.events.length;
	const r = await run({ name: "waker", message: TEAMS([{ action: "send", to: "beta", body: "SAY for waker" }, { action: "wait", ms: 60_000 }]), waitMs: 60_000 });
	assert.match(r.text, /^\[settled\] subagent waker.*team: 1 team message\(s\) for you follow this result\.$/s);
	const seen = requestsBy("waker").at(-1).messages;
	assert.ok(seen.some((m) => m.role === "tool" && /^Sent #\d+ to beta \(woken\)\.$/.test(rawText(m))), "beta was not woken");
	assert.match(text(seen.at(-1)), /^\[team #\d+\] beta → you \(direct\):\nFinal reply of beta \(settled\); full text: .*final\.md\n\nfor waker$/);
	const note = requestsBy("beta").at(-1).messages.findLast((m) => m.role === "user" && !isTeam(m));
	assert.equal(rawText(note), "waker sent you a team message. Act on your team messages.");
	const rules = rawText(requestsBy("beta").at(-1).messages.findLast((m) => rawText(m).startsWith("[team] You are beta,")));
	assert.match(
		rules,
		/\nUse team send to hand results to whoever needs them and to coordinate\. In this run, your direct messages cannot wake stopped members, and a direct message to one tells the main agent; post news that can wait on the board with a title, mentioning them, and they read it in full when they next run\.\n/,
	);
	assert.match(
		rules,
		/\nYour final reply goes to waker, or to main if waker has stopped by then\. Keep it short: for what you already sent to waker or posted on the board, name the #seq; write out anything else\.\n\n/,
	);
	assert.ok(!team.messages(from).some((m) => m.customType === "subagent-result" && /subagent beta/.test(m.content)), "beta's result reached main");
	assert.match((await team.call({ action: "status", id: "beta" })).text, /Its result was sent to waker as team message #\d+\./);
});

await step("a woken member's final reply reaches the main agent when its waker has stopped", async () => {
	const from = team.events.length;
	const r = await run({ name: "quitter", message: TEAM({ action: "send", to: "beta", body: "SLOW 3000 SAY for quitter" }) });
	assert.match(r.text, /team: Sent #\d+ to beta \(woken\)\.(\n\n\(Background: .*\))?$/);
	const note = await team.waitMessage("subagent-result", from);
	assert.match(note.content, /^\[settled\] subagent beta[^\n]*\n\n\(woken by quitter; quitter had stopped\)\n\nfor quitter$/);
	await team.waitEvent((e) => e.type === "agent_settled", note.at);
});

await step("a run woken by a member cannot wake others; a notice that starts a turn tells the main agent, which can wake the recipient", async () => {
	await run({ name: "relay", message: "SAY relay ready" });
	await run({ name: "sink", message: "SAY sink ready" });
	const from = team.events.length;
	const relayed = TEAM({ action: "send", to: "sink", body: "SAY sink got it" });
	await run({ name: "origin", message: TEAMS([{ action: "send", to: "relay", body: relayed }, { action: "wait", ms: 60_000 }]), waitMs: 0 });
	const idle = team.events.length;
	const notice = await team.waitMessage("team-notice", from);
	assert.match(
		notice.content,
		/^\[team\] #(\d+) relay → sink is waiting in sink's inbox: sink is stopped, and relay's run cannot wake it\. If and when you think sink should run, send it a short direct message: that wakes it, and it reads #\1 itself, so you need not repeat it\.$/,
	);
	// A triggered turn emits agent_start before its message; the idle main agent's turn starts with the notice.
	assert.ok(team.events.slice(idle, notice.at).some((e) => e.type === "agent_start"), "the notice started no turn");
	// origin's result comes after relay's final reply reached origin.
	const result = await team.waitMessage("subagent-result", from);
	assert.match(result.content, /^\[settled\] subagent origin/);
	await team.waitEvent((e) => e.type === "agent_settled", result.at);
	const sendResult = requestsBy("relay").at(-1).messages.findLast((m) => m.role === "tool");
	assert.equal(rawText(sendResult), `Sent #${notice.content.match(/#(\d+)/)[1]} to sink (stopped, not woken: your run was started by origin's message, so it cannot start others; the main agent was told).`);
	const mark = team.events.length;
	const woke = await teamCall({ action: "send", to: "sink", body: "SAY sink woken" });
	assert.match(woke.text, /\(woken\)\.$/);
	assert.match(await report("sink", mark), /sink woken$/);
	assert.match(
		text(requestsBy("sink").at(-1).messages.at(-1)),
		/\[team #\d+\] relay → you \(direct\):\nSAY sink got it\n\n\[team #\d+\] main → you \(direct\):\nSAY sink woken\n\n\[team\] Board: 1 new post — #\d+ main: joined: origin — test member \(team history\)\.$/,
	);
});

await step("a direct message to several members from a run woken by a member wakes none of them and tells the main agent about each", async () => {
	await run({ name: "ray", message: "SAY ray ready" });
	const from = team.events.length;
	const relayed = TEAM({ action: "send", to: ["ann", "bob"], body: "SAY not woken" });
	await run({ name: "orin", message: TEAMS([{ action: "send", to: "ray", body: relayed }, { action: "wait", ms: 60_000 }]), waitMs: 0 });
	const result = await team.waitEvent((e) => asMessage(e)?.customType === "subagent-result" && asMessage(e).details?.id === "orin", from);
	await team.waitEvent((e) => e.type === "agent_settled", team.events.indexOf(result));
	const sendResult = rawText(requestsBy("ray").at(-1).messages.findLast((m) => m.role === "tool"));
	const seq = sendResult.match(/^Sent #(\d+) /)?.[1] ?? assert.fail(sendResult);
	const why = "stopped, not woken: your run was started by orin's message, so it cannot start others; the main agent was told";
	assert.equal(sendResult, `Sent #${seq} to ann (${why}), bob (${why}).`);
	assert.deepEqual(
		team.messages(from).filter((m) => m.customType === "team-notice" && m.content.startsWith(`[team] #${seq} `)).map((m) => m.content.match(/→ (\w+) is waiting/)[1]),
		["ann", "bob"],
	);
});

for (const stopped of [false, true]) {
	await step(`a ${stopped ? "stopped" : "running"} member the main agent aborted wakes only for the main agent's direct message`, async () => {
		const name = stopped ? "locked-stopped" : "locked";
		const sender = stopped ? "knocker-stopped" : "knocker";
		await run({ name, message: stopped ? "SAY ready" : "HANG", waitMs: stopped ? 30_000 : 300 });
		assert.match((await team.call({ action: "abort", id: name, retire: false, when: "now" })).text, stopped ? /^\[settled\]/ : /^\[aborted\]/);
		const before = requestsBy(name).length;
		const from = team.events.length;
		// The notice ends run's wait, as a team message does, and joins the session after that tool call.
		const knock = await run({ name: sender, message: TEAM({ action: "send", to: name, body: "SAY knocked" }) });
		assert.match(knock.text, /Returned early: subagent messages follow this result\./);
		const notice = await team.waitMessage("team-notice", from, 1000);
		assert.ok(notice.content.includes(`${sender} → ${name} is waiting in ${name}'s inbox: you stopped ${name} with abort, so ${sender}'s message cannot wake it.`), notice.content);
		const toolEnd = team.events.findIndex((e, i) => i >= from && e.type === "tool_execution_end");
		const settled = team.events.findIndex((e, i) => i > toolEnd && e.type === "agent_settled");
		assert.ok(toolEnd < notice.at && notice.at < settled, "the notice did not join after the tool call");
		assert.ok((await report(sender, from)).includes(`to ${name} (stopped, not woken: the main agent stopped it; the main agent was told).`));
		assert.equal(requestsBy(name).length, before, "the member's message woke the aborted recipient");
		const mark = team.events.length;
		const woke = await teamCall({ action: "send", to: name, body: "SAY unlocked" });
		assert.ok(woke.text.endsWith(`to ${name} (woken).`), woke.text);
		assert.match(await report(name, mark), /^\[settled\] subagent .*unlocked$/s);
	});
}

await step("abort stops a woken member before its run starts; extension notices from the run show in its result", async () => {
	const slow = join(WORK_DIR, "slow-start-extension.ts");
	fs.writeFileSync(
		slow,
		'export default function (pi) { pi.on("before_agent_start", async (_event, ctx) => { ctx.ui.notify("starting slowly", "warning"); await new Promise((done) => setTimeout(done, 3000)); }); pi.on("turn_start", (_event, ctx) => ctx.ui.notify("turn started", "info")); }\n',
	);
	const ready = await run({ name: "late", message: "SAY late ready", args: ["-e", slow] });
	assert.match(ready.text, /^\[settled\] subagent late[^\n]*\n\nNotices: turn started\n\nlate ready/);
	const before = requestsBy("late").length;
	assert.match((await teamCall({ action: "send", to: "late", body: "SAY should not run" })).text, /\(woken\)\.$/);
	const started = Date.now();
	assert.match((await team.call({ action: "abort", id: "late", retire: false })).text, /^\[aborted\] subagent late/);
	assert.ok(Date.now() - started < 8000, "abort waited for the kill timeout");
	await sleep(4000);
	assert.equal(requestsBy("late").length, before, "the aborted run reached the model");
});

await step("abort with retire true removes a stopped member from the team and lists its unread direct messages", async () => {
	await run({ name: "retiree", description: "leaves the team", message: "HANG", waitMs: 300 });
	assert.match((await team.call({ action: "abort", id: "retiree", retire: false, when: "now" })).text, /^\[aborted\] subagent retiree/);
	// A member's direct message to the locked member waits in its inbox.
	const from = team.events.length;
	await run({ name: "doorman", message: TEAM({ action: "send", to: "retiree", body: "SAY never read" }), waitMs: 0 });
	const seq = (await team.waitMessage("team-notice", from)).content.match(/^\[team\] #(\d+) doorman → retiree is waiting/)?.[1] ?? assert.fail("no notice");
	await finished("doorman");
	const retired = await team.call({ action: "abort", id: "retiree", retire: true });
	assert.match(
		retired.text,
		new RegExp(`^retiree is retired: it left the team; its session and final\\.md stay\\. retiree had 1 unread message: #${seq}\\.\\n\\n\\[aborted\\] subagent retiree`),
	);
	assert.doesNotMatch((await teamCall({ action: "members" })).text, /retiree/);
	assert.doesNotMatch((await team.call({ action: "status" })).text, /retiree/);
	const later = await team.call({ action: "status", id: "retiree" });
	assert.match(later.text, /^\[aborted\] subagent retiree/);
	// The member was locked and holds an unread message, yet nothing wakes it once retired.
	for (const shown of [retired.text, later.text]) assert.doesNotMatch(shown, /wakes it/);
	await run({ name: "newbie", message: "SAY newbie here" });
	const preamble = rawText(requestsBy("newbie")[0].messages.find((m) => rawText(m).startsWith("[team] You are newbie,")));
	assert.match(preamble, /\n- doorman: /);
	assert.doesNotMatch(preamble, /^- retiree:/m);
	for (const [r, error] of [
		[await teamCall({ action: "send", to: "retiree", body: "x" }), /retiree is retired/],
		[await teamCall({ action: "send", title: "x", body: "x", mentions: ["retiree"] }), /retiree is retired/],
		[await run({ name: "retiree", message: "SAY x" }), /retiree is retired/],
		[await team.call({ action: "compact", id: "retiree" }), /retiree is retired/],
		[await team.call({ action: "abort", id: "retiree", retire: true }), /retiree is retired/],
	]) {
		assert.ok(r.isError, r.text);
		assert.match(r.text, error);
	}
	// mentions all leaves a retired member out.
	assert.doesNotMatch((await teamCall({ action: "send", title: "to everyone", body: "to everyone", mentions: ["all"] })).text, /retiree/);
});

await step("wait returns early when a message arrives, and the message follows the tool result; an unmentioned board post does not end it", async () => {
	await run({ name: "delta", message: TEAM({ action: "wait", ms: 60_000 }), waitMs: 0 });
	await until(() => requestsBy("delta").length > 0);
	await sleep(1000);
	const started = Date.now();
	const posted = (await teamCall({ action: "send", title: "not for delta", body: "not for delta" })).text.match(/^Posted #(\d+)\./)[1];
	await sleep(1500);
	assert.match((await team.call({ action: "status", id: "delta", waitMs: 0 })).text, /^\[running\] .* · team \d+s · /);
	await teamCall({ action: "send", to: "delta", body: "wake up" });
	// delta can finish before a status call starts waiting; that call then finds the result already sent as a message.
	await finished("delta");
	assert.ok(Date.now() - started < 20_000, "the wait was not cut short");
	const next = requestsBy("delta").at(-1).messages;
	assert.equal(next.at(-3).role, "tool");
	assert.equal(rawText(next.at(-3)), "1 team message(s) for you follow this result.");
	assert.match(text(next.at(-2)), /^\[team #\d+\] main → you \(direct\):\nwake up$/);
	assert.equal(text(next.at(-1)), `[team] Board: 1 new post — #${posted} main: not for delta (team history).`);
});

await step("a team message wakes an idle main agent", async () => {
	await run({ name: "echo", message: `SLOW 2000 ${TEAM({ action: "send", to: "main", body: "note for main" })}`, waitMs: 0 });
	const idle = team.events.length;
	const note = await team.waitMessage("team-message", idle);
	assert.match(note.content, /^\[team #\d+\] echo → you \(direct\):\nnote for main$/);
	assert.equal(note.details.from, "echo");
	await team.waitEvent((e) => e.type === "agent_start", idle);
	await team.waitMessage("subagent-result", idle);
	await team.waitEvent((e) => e.type === "agent_settled", team.events.length - 1);
});

await step("a member's final result stays behind its team messages", async () => {
	const from = team.events.length;
	const r = await run({ name: "foxtrot", message: TEAM({ action: "send", to: "main", body: "before the result" }), waitMs: 30_000 });
	assert.doesNotMatch(r.text, /team: Sent/);
	await team.waitMessage("subagent-result", from);
	assert.deepEqual(
		team.messages(from).map((m) => m.customType),
		["team-message", "subagent-result"],
	);
	await team.waitEvent((e) => e.type === "agent_settled", team.events.length - 1);
});

const DIGEST = /^\[team\] Board: /;

await step("a running member gets an unmentioned board post as a digest line after its next tool results", async () => {
	await run({ name: "kilo", message: `SLOW 3000 ${TEAM({ action: "members" })}`, waitMs: 0 });
	await until(() => requestsBy("kilo").length > 0);
	const posted = await teamCall({ action: "send", title: "board news for everyone", body: "board news\nfor   everyone" });
	const seq = posted.text.match(/^Posted #(\d+)\./)[1];
	await finished("kilo");
	const next = requestsBy("kilo").at(-1).messages;
	assert.equal(next.at(-2).role, "tool");
	assert.equal(text(next.at(-1)), `[team] Board: 1 new post — #${seq} main: board news for everyone (team history).`);
	assert.ok(!next.some((m) => rawText(m).includes("main → #team")), "the full post was delivered");
});

await step("hiring posts a join announcement that a running member gets in its digest; neither the new member's digest nor the main agent's lists it", async () => {
	await run({ name: "papa", message: `SLOW 3000 ${TEAM({ action: "members" })}`, waitMs: 0 });
	await until(() => requestsBy("papa").length > 0);
	const from = team.events.length;
	await run({ name: "quebec", description: "joins while papa works", message: "SAY quebec here" });
	const post = (await teamCall({ action: "history", query: "joined: quebec" })).text;
	const seq = post.match(/^\[team #(\d+)\] you → #team: joined: quebec — joins while papa works\njoined: quebec — joins while papa works$/)?.[1];
	assert.ok(seq, post);
	await finished("papa");
	const next = requestsBy("papa").at(-1).messages;
	assert.equal(next.at(-2).role, "tool");
	assert.equal(text(next.at(-1)), `[team] Board: 1 new post — #${seq} main: joined: quebec — joins while papa works (team history).`);
	assert.ok(requestsBy("quebec")[0].messages.some((m) => rawText(m).includes("[team] Board:")), "the new member got no digest of the board before it joined");
	assert.ok(!requestsBy("quebec").some((body) => body.messages.some((m) => rawText(m).includes("joined: quebec"))), "the new member got a digest of its own join post");
	assert.ok(!team.messages(from).some((m) => m.customType === "team-notice"), "the main agent got a digest of its own post");
});

await step("a digest alone does not continue a run at settle, and a board post does not wake a stopped member", async () => {
	await run({ name: "lima", message: "SLOW 3000 SAY lima done", waitMs: 0 });
	await until(() => requestsBy("lima").length > 0);
	await teamCall({ action: "send", title: "while lima writes", body: "while lima writes" });
	await finished("lima");
	assert.match((await team.call({ action: "status", id: "lima" })).text, /^\[settled\] subagent lima · fake\/fake-model:off · 1 turns/);
	const before = requestsBy("lima").length;
	assert.equal(before, 1);
	assert.match((await teamCall({ action: "send", title: "lima is stopped", body: "lima is stopped" })).text, /^Posted #\d+\. It notified nobody; members see it in history\.$/);
	await sleep(1000);
	assert.equal(requestsBy("lima").length, before, "a board post woke a stopped member");
});

await step("a member woken by a direct message acts on it, and its run-start message holds the digest of the posts it missed", async () => {
	const mark = team.events.length;
	assert.match((await teamCall({ action: "send", to: "lima", body: "SAY lima woken" })).text, /\(woken\)\.$/);
	assert.match(await report("lima", mark), /^\[settled\] subagent lima[^\n]*\n\nlima woken$/);
	assert.match(
		text(requestsBy("lima").at(-1).messages.at(-1)),
		/\[team #\d+\] main → you \(direct\):\nSAY lima woken\n\n\[team\] Board: 2 new posts — #\d+ main: while lima writes; #\d+ main: lima is stopped \(team history\)\.$/,
	);
});

await step("after team history on the board, no digest repeats those posts", async () => {
	await run({ name: "mike", message: `SLOW 3000 ${TEAMS([{ action: "history", limit: 1 }, { action: "members" }])}`, waitMs: 0 });
	await until(() => requestsBy("mike").length > 0);
	await teamCall({ action: "send", title: "read in history", body: "read in history" });
	await finished("mike");
	const seenBy = requestsBy("mike");
	assert.equal(seenBy.length, 3);
	assert.match(rawText(seenBy[1].messages.at(-1)), /main → #team: read in history\nread in history\n\nMore: history before=\d+\.$/);
	assert.ok(!seenBy.some((body) => body.messages.some((m) => DIGEST.test(rawText(m)))), "a digest repeated posts read in history");
});

await step("a member's history marks only the posts it shows; the next digest lists the other unseen posts and how to read the earlier ones", async () => {
	await run({ name: "xray", message: `SLOW 3000 ${TEAMS([{ action: "history", limit: 1 }, { action: "members" }])}`, waitMs: 0 });
	await until(() => requestsBy("xray").length > 0);
	const seqs = [];
	// The digest shows each title in full, a 100-character one included.
	const titles = ["post 1", "post 2", `post 3 ${"x".repeat(93)}`, "post 4", "post 5", "post 6", "post 7"];
	for (const [i, title] of titles.entries()) seqs.push((await teamCall({ action: "send", title, body: `body ${i + 1}` })).text.match(/^Posted #(\d+)\./)[1]);
	await finished("xray");
	const seenBy = requestsBy("xray");
	assert.equal(seenBy.length, 3);
	const afterHistory = seenBy[1].messages;
	assert.equal(rawText(afterHistory.at(-2)), `[team #${seqs[6]}] main → #team: post 7\nbody 7\n\nMore: history before=${seqs[6]}.`);
	assert.equal(
		text(afterHistory.at(-1)),
		`[team] Board: 6 new posts — ${[1, 2, 3, 4, 5].map((i) => `#${seqs[i]} main: ${titles[i]}`).join("; ")}; +1 earlier (team history before=${seqs[1]}).`,
	);
	assert.ok(!seenBy[2].messages.slice(afterHistory.length).some((m) => DIGEST.test(rawText(m))), "a digest repeated posts");
});

await step("a post a member read in history stays out of its digest when it is woken again", async () => {
	await run({ name: "zulu", message: `SLOW 3000 ${TEAM({ action: "history", limit: 1 })}`, waitMs: 0 });
	await until(() => requestsBy("zulu").length > 0);
	await teamCall({ action: "send", title: "read by zulu", body: "read by zulu" });
	await finished("zulu");
	assert.match(rawText(requestsBy("zulu").at(-1).messages.at(-1)), /main → #team: read by zulu\nread by zulu\n\nMore: history before=\d+\.$/);
	const seq = (await teamCall({ action: "send", title: "after zulu", body: "after zulu" })).text.match(/^Posted #(\d+)\./)[1];
	const mark = team.events.length;
	assert.match((await teamCall({ action: "send", to: "zulu", body: "SAY zulu again" })).text, /\(woken\)\.$/);
	assert.match(await report("zulu", mark), /zulu again$/);
	assert.match(
		text(requestsBy("zulu").at(-1).messages.at(-1)),
		new RegExp(`main → you \\(direct\\):\\nSAY zulu again\\n\\n\\[team\\] Board: 1 new post — #${seq} main: after zulu \\(team history\\)\\.$`),
	);
});

await step("a new member's first digest lists the board posts from before it joined, without its join announcement; a post it reads in history stays out of later digests", async () => {
	const before = [];
	// The oldest of the six is past the digest's latest five, so the digest points to it.
	for (const n of [0, 1, 2, 3, 4, 5]) before.push((await teamCall({ action: "send", title: `before hotel ${n}`, body: `before hotel ${n}` })).text.match(/^Posted #(\d+)\./)[1]);
	await run({ name: "hotel", message: `SLOW 3000 ${TEAMS([{ action: "history", limit: 1 }, { action: "members" }])}`, waitMs: 0 });
	await until(() => requestsBy("hotel").length > 0);
	const during = (await teamCall({ action: "send", title: "during hotel", body: "during hotel" })).text.match(/^Posted #(\d+)\./)[1];
	await finished("hotel");
	const seenBy = requestsBy("hotel");
	assert.equal(seenBy.length, 3);
	const start = text(seenBy[0].messages.find((m) => rawText(m).startsWith("[team] You are hotel,")));
	const [, count, earlier] = start.match(
		new RegExp(
			`\\[team\\] Board: (\\d+) new posts — ${[1, 2, 3, 4, 5].map((n) => `#${before[n]} main: before hotel ${n}`).join("; ")}; \\+(\\d+) earlier \\(team history before=${before[1]}\\)\\.$`,
		),
	) ?? assert.fail(start);
	// Every pre-hire board post counts, so the earlier steps' posts add to "before hotel 0".
	assert.ok(Number(earlier) >= 1 && Number(count) === Number(earlier) + 5, start);
	assert.doesNotMatch(start, /joined: hotel/);
	assert.match(rawText(seenBy[1].messages.at(-1)), new RegExp(`\\[team #${during}\\] main → #team: during hotel\\nduring hotel\\n\\nMore: history before=${during}\\.$`));
	assert.ok(!seenBy.some((body) => body.messages.some((m) => DIGEST.test(rawText(m)))), "a digest repeated a post read in history");
	const mark = team.events.length;
	assert.match((await teamCall({ action: "send", to: "hotel", body: "SAY hotel again" })).text, /\(woken\)\.$/);
	assert.match(await report("hotel", mark), /hotel again$/);
	assert.doesNotMatch(rawText(requestsBy("hotel").at(-1).messages.at(-1)), /\[team\] Board:/);
});

await step("team messages in a batch another extension drops arrive at the member's next pull, each once, ten per pull", async () => {
	const marker = join(WORK_DIR, "dropped");
	const dropper = join(WORK_DIR, "drop-extension.ts");
	// Loaded after the subagent extension, it empties the first turn_end batch that holds a team message, as an invalid boundary result does.
	fs.writeFileSync(
		dropper,
		`import fs from "node:fs";
export default function (pi) {
	let dropped = false;
	pi.on("turn_end", async (event) => {
		if (dropped || !event.entries.some((e) => e.type === "custom_message" && e.customType === "team-message" && e.details?.seq)) return;
		dropped = true;
		fs.writeFileSync(${JSON.stringify(marker)}, "");
		// Time for another message to arrive before the next pull.
		await new Promise((done) => setTimeout(done, 3000));
		return { entries: [] };
	});
}
`,
	);
	const args = ["--no-extensions", "-e", fileURLToPath(new URL("..", import.meta.url)), "-e", dropper];
	await run({ name: "india", message: `SLOW 8000 ${TEAMS([{ action: "members" }, { action: "members" }, { action: "members" }])}`, args, waitMs: 0 });
	await until(() => requestsBy("india").length > 0);
	// Twelve messages for india, more than one pull returns: a board post that mentions it, then direct messages.
	await team.say(TEAMS([{ action: "send", title: "board for india", body: "board for india", mentions: ["india"] }, ...Array.from({ length: 11 }, (_, i) => ({ action: "send", to: "india", body: `dm ${i}` }))]));
	await until(() => fs.existsSync(marker));
	const last = Number((await teamCall({ action: "send", to: "india", body: "after the drop" })).text.match(/^Sent #(\d+) to india \(running\)\.$/)[1]);
	await finished("india");
	const seqs = (messages) => messages.flatMap((m) => [...rawText(m).matchAll(/\[team #(\d+)\]/g)].map((match) => Number(match[1])));
	const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);
	const seenBy = requestsBy("india");
	assert.equal(seenBy.length, 4);
	assert.equal(seenBy[1].messages.at(-1).role, "tool", "the dropped batch reached the model");
	assert.match(text(seenBy[1].messages.at(-1)), /^Members:/);
	assert.deepEqual(seqs(seenBy[2].messages.slice(-10)), range(last - 12, 10));
	assert.equal(text(seenBy[2].messages.at(-10)), `[team #${last - 12}] main → #team, mentions you: board for india\nboard for india`);
	assert.match(text(seenBy[2].messages.at(-1)), /\n\(3 more team messages for you are pending; they arrive after your next tool results or before your run ends\.\)$/);
	assert.deepEqual(seqs(seenBy[3].messages.slice(-3)), range(last - 2, 3));
	assert.deepEqual(seqs(seenBy[3].messages), range(last - 12, 13));
	// The next run starts with only the message that woke it.
	const mark = team.events.length;
	assert.match((await teamCall({ action: "send", to: "india", body: "SAY india again" })).text, /\(woken\)\.$/);
	assert.match(await report("india", mark), /india again$/);
	assert.deepEqual(seqs([requestsBy("india").at(-1).messages.at(-1)]), [last + 1]);
});

await step("the main agent's history marks only the posts it shows; its next digest lists the other unseen posts", async () => {
	await run({ name: "yankee", message: `SLOW 1500 ${TEAMS([1, 2, 3].map((n) => ({ action: "send", title: `yankee ${n}`, body: `yankee ${n}` })))}`, waitMs: 0 });
	await until(() => requestsBy("yankee").length > 0);
	const from = team.events.length;
	team.prompt(`SLOW 6000 ${TEAMS([{ action: "history", limit: 1 }, { action: "members" }])}`);
	const result = await team.waitMessage("subagent-result", from);
	await team.waitEvent((e) => e.type === "agent_settled", result.at);
	// yankee's final reply is the result of its last post.
	const last = Number(result.content.match(/Posted #(\d+)\./)[1]);
	const shown = team.events.slice(from).find((e) => e.type === "tool_execution_end" && e.toolName === "team");
	assert.equal(shown.result.content[0].text, `[team #${last}] yankee → #team: yankee 3\nyankee 3\n\nMore: history before=${last}.`);
	assert.deepEqual(seenMarks(team, from).filter((data) => data.covered).map((data) => data.covered), [[last]]);
	assert.deepEqual(
		team.messages(from).filter((m) => m.customType === "team-notice").map((m) => m.content),
		[`[team] Board: 2 new posts — #${last - 2} yankee: yankee 1; #${last - 1} yankee: yankee 2 (team history).`],
	);
});

await step("the main agent gets a digest of other members' board posts at its turn boundary after a tool call", async () => {
	const from = team.events.length;
	const r = await run({ name: "november", message: TEAM({ action: "send", title: "member news", body: "member news" }) });
	const seq = r.text.match(/team: Posted #(\d+)\./)[1];
	const digests = team.messages(from).filter((m) => m.customType === "team-notice");
	assert.deepEqual(
		digests.map((m) => m.content),
		[`[team] Board: 1 new post — #${seq} november: member news (team history).`],
	);
	// Only the board cursor: a seq would mark a message seen.
	assert.deepEqual(Object.keys(digests[0].details), ["team", "board"]);
	assert.equal(digests[0].details.board, Number(seq));
	const seen = requests().find((body) => body.messages.some((m) => m.role === "user" && text(m) === digests[0].content));
	assert.equal(seen.messages.at(-2).role, "tool");
});

await step("a run that a member's result starts gets the digest ahead of that result, even without tool calls", async () => {
	await run({ name: "oscar", message: `SLOW 2000 ${TEAM({ action: "send", title: "posted while main idles", body: "posted while main idles" })}`, waitMs: 0 });
	const idle = team.events.length;
	const result = await team.waitMessage("subagent-result", idle);
	await team.waitEvent((e) => e.type === "agent_settled", result.at);
	const seq = result.content.match(/team: Posted #(\d+)\./)[1];
	const digest = `[team] Board: 1 new post — #${seq} oscar: posted while main idles (team history).`;
	assert.deepEqual(
		team.messages(idle).map((m) => [m.customType, m.customType === "team-notice" ? m.content : ""]),
		[["team-notice", digest], ["subagent-result", ""]],
	);
	const answered = requestFor("[settled] subagent oscar").messages;
	assert.equal(text(answered.at(-2)), digest);
});

/** The seq in a send result: `Posted #n.` or `Sent #n to ...`. */
const seqOf = (result) => Number(result.text.match(/^(?:Posted|Sent) #(\d+)/)?.[1] ?? assert.fail(result.text));
/** The `covered` of the main agent's last history call, from its seen mark. */
const lastCovered = () => seenMarks(team).findLast((data) => data.covered)?.covered;

await step("a reply cites what it answers and its thread; the digest groups new posts by thread", async () => {
	const fixture = seqOf(await teamCall({ action: "send", title: "Fixture 7 breaks", body: "fixture" }));
	await run({ name: "digester", message: `SLOW 6000 ${TEAM({ action: "members" })}`, waitMs: 0 });
	await until(() => requestsBy("digester").length > 0);
	const a1 = seqOf(await teamCall({ action: "send", replyTo: fixture, body: "a1" }));
	const c = [];
	for (const n of [1, 2, 3, 4]) c.push(seqOf(await teamCall({ action: "send", title: `c${n}`, body: `c${n}` })));
	const a2 = seqOf(await teamCall({ action: "send", replyTo: a1, body: "a2" }));
	const suite = seqOf(await teamCall({ action: "send", title: "Suite green", body: "suite" }));
	const b1 = seqOf(await teamCall({ action: "send", replyTo: suite, body: "b1" }));
	await finished("digester");
	const next = requestsBy("digester").at(-1).messages;
	assert.equal(next.at(-2).role, "tool");
	assert.equal(
		text(next.at(-1)),
		`[team] Board: 8 new posts in 6 threads — #${c[1]} main: c2; #${c[2]} main: c3; #${c[3]} main: c4; #${fixture} "Fixture 7 breaks": 2 new replies (#${a1} main, #${a2} main); #${suite} main: Suite green, 1 reply (#${b1} main); +1 earlier (team history before=${c[0] + 1}).`,
	);
	assert.equal(
		(await teamCall({ action: "history", thread: a2 })).text,
		[
			`Thread #${fixture} "Fixture 7 breaks" · 3 messages`,
			"",
			`[team #${fixture}] you → #team: Fixture 7 breaks`,
			"fixture",
			"",
			`  [team #${a1}] you → #team, replying to #${fixture} "Fixture 7 breaks":`,
			"  a1",
			"",
			`    [team #${a2}] you → #team, replying to #${a1} in #${fixture} "Fixture 7 breaks":`,
			"    a2",
		].join("\n"),
	);
	assert.deepEqual(lastCovered(), [fixture, a1, a2]);
});

await step("board history lists threads by latest activity, newest or oldest first, and pages with before and after; a query matches replies", async () => {
	const p = [];
	for (const n of [1, 2, 3]) p.push(seqOf(await teamCall({ action: "send", title: `P${n}`, body: `p${n}` })));
	const q = seqOf(await teamCall({ action: "send", replyTo: p[0], body: "needle-7f3 in a reply" }));
	const item = (i) => `[team #${p[i]}] you → #team: P${i + 1}\np${i + 1}${i === 0 ? `\n1 reply, latest #${q}` : ""}`;
	const history = async (params) => (await teamCall({ action: "history", after: p[0] - 1, ...params })).text;
	assert.equal(await history({}), [item(0), item(2), item(1)].join("\n\n"));
	assert.equal(await history({ limit: 2 }), `${item(0)}\n\n${item(2)}\n\nMore: history before=${p[2]}.`);
	assert.equal(await history({ before: p[2] }), item(1));
	assert.equal(await history({ order: "oldest", limit: 2 }), `${item(1)}\n\n${item(2)}\n\nMore: history order=oldest after=${p[2]}.`);
	assert.equal(await history({ order: "oldest", after: p[2] }), item(0));
	assert.deepEqual(lastCovered(), [p[0]]);
	assert.equal((await teamCall({ action: "history", query: "NEEDLE-7F3" })).text, `${item(0)}\nmatches #${q}`);
});

await step("a thread shows only visible messages as a tree and pages full bodies within its budget", async () => {
	await run({ name: "reader", message: "SAY reader ready" });
	await run({ name: "outsider", message: "SAY outsider ready" });
	const root = Number((await run({ name: "writer", message: TEAM({ action: "send", title: "Thread root", body: "root body" }) })).text.match(/team: Posted #(\d+)/)[1]);
	const board = await teamCall({ action: "send", replyTo: root, body: "board reply" });
	assert.match(board.text, /to writer \(stopped; board posts do not wake\)\.$/);
	const onward = TEAM({ action: "send", to: "reader", replyTo: root, body: "SAY between members zq-private" });
	let mark = team.events.length;
	const direct = seqOf(await teamCall({ action: "send", to: "writer", replyTo: seqOf(board), body: onward }));
	await report("writer", mark);
	await finished("reader");
	const sent = requestsBy("writer").flatMap((body) => body.messages).map(rawText).find((t) => /^Sent #\d+ to reader \(woken\)\.$/.test(t)) ?? assert.fail("writer did not wake reader");
	const between = seqOf({ text: sent });
	const title = `#${root} "Thread root"`;
	const top = [`[team #${root}] writer → #team: Thread root`, "root body", ""];
	const boardReply = (who) => [`  [team #${seqOf(board)}] ${who} → #team, replying to ${title}:`, "  board reply"];
	assert.equal(
		(await teamCall({ action: "history", thread: direct })).text,
		[
			`Thread ${title} · 4 messages`,
			"",
			...top,
			...boardReply("you"),
			"",
			`    [team #${direct}] you → writer (direct), replying to #${seqOf(board)} in ${title}:`,
			`    ${onward}`,
			"",
			`  [team #${between}] writer → reader (direct), replying to ${title}:`,
			"  SAY between members zq-private",
		].join("\n"),
	);
	// A third member sees neither direct message, in the thread or in board history; the main agent sees both.
	const boardItem = (replies, latest) => `${top.slice(0, 2).join("\n")}\n${replies}, latest #${latest}`;
	const privateMatch = `${boardItem("3 replies", between)}\nmatches #${direct}, #${between}`;
	assert.equal((await teamCall({ action: "history", after: root - 1 })).text, boardItem("3 replies", between));
	assert.equal((await teamCall({ action: "history", query: "ZQ-PRIVATE" })).text, privateMatch);
	mark = team.events.length;
	const outsiderCalls = [{ thread: direct }, { thread: root }, { after: root - 1 }, { query: "ZQ-PRIVATE" }, { thread: root, after: root, limit: 1 }].map((params) => ({ action: "history", ...params }));
	await teamCall({ action: "send", to: "outsider", body: TEAMS(outsiderCalls) });
	await report("outsider", mark);
	const shown = requestsBy("outsider").at(-1).messages.filter((m) => m.role === "tool").map(rawText).slice(-5);
	assert.equal(shown[0], `#${direct} is a direct message between main and writer, which you cannot see; ask one of them to forward what you need`);
	assert.equal(shown[1], [`Thread ${title} · 2 messages`, "", ...top, ...boardReply("main")].join("\n"));
	assert.equal(shown[2], boardItem("1 reply", seqOf(board)));
	assert.equal(shown[3], "No messages.");
	assert.equal(shown[4], [`Thread ${title} · 2 messages`, "", ...boardReply("main")].join("\n"));
	const mixed = await teamCall({ action: "history", thread: root, query: "x" });
	assert.ok(mixed.isError, mixed.text);
	assert.match(mixed.text, /thread takes no with, query, or before; use after to continue/);
	// Three long replies need two pages; neither page shortens a body.
	const long = [];
	for (const n of [1, 2, 3]) long.push(seqOf(await teamCall({ action: "send", replyTo: root, body: `long ${n}\n${"y".repeat(6000)}` })));
	const first = (await teamCall({ action: "history", thread: root })).text;
	assert.ok(first.length <= 16_000, `${first.length}`);
	assert.ok(first.includes(`long 1\n  ${"y".repeat(6000)}`));
	assert.ok(first.includes(`long 2\n  ${"y".repeat(6000)}`));
	assert.ok(first.endsWith(`More: history thread=${root} after=${long[1]}.`));
	assert.deepEqual(lastCovered(), [root, seqOf(board), direct, between, long[0], long[1]]);
	const next = (await teamCall({ action: "history", thread: root, after: long[1] })).text;
	assert.ok(next.endsWith(`long 3\n  ${"y".repeat(6000)}`));
	assert.deepEqual(lastCovered(), [long[2]]);
});

await step("thread continuation bounds wide and deep trees without skipping or repeating message bodies", async () => {
	const session = join(WORK_DIR, "history-budget.jsonl");
	fs.writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "history-budget", timestamp: new Date().toISOString(), cwd: join(WORK_DIR, "project") })}\n`);
	const records = [{ t: "team", id: "history-budget" }];
	const cases = [];
	for (const [root, count, chain] of [[1, 500, false], [1000, 100, true], [2000, 3, true]]) {
		const posts = Array.from({ length: count }, (_, i) => ({
			t: "msg", seq: root + i, at: Date.now(), from: "main", to: "team", notify: [],
			...(i ? { replyTo: chain ? root + i - 1 : i === 49 ? root + 1 : root } : { title: `History budget ${root}` }),
			body: root === 2000 && i === 2 ? `${"x\n".repeat(3998)}end` : `[body:${root + i}]`,
		}));
		records.push(...posts);
		cases.push(posts);
	}
	const recipients = Array.from({ length: 700 }, (_, i) => `recipient-${String(i).padStart(14, "0")}`);
	records.push(...recipients.map((name) => ({ t: "member", name, description: "history recipient", cwd: join(WORK_DIR, "project"), args: [] })));
	const routing = { t: "msg", seq: 3000, at: Date.now(), from: "main", to: recipients, notify: recipients, body: "r".repeat(8000) };
	records.push(routing);
	cases.push([routing]);
	fs.mkdirSync(session.replace(/\.jsonl$/, ""));
	fs.writeFileSync(join(session.replace(/\.jsonl$/, ""), "team.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
	const p = startParent(["--session", session]);
	current = p;
	try {
		for (const posts of cases) {
			const root = posts[0].seq;
			let after = 0;
			const read = [];
			for (let pages = 0; ; pages++) {
				assert.ok(pages < posts.length, "continuation did not finish");
				const result = await p.call({ action: "history", thread: root, ...(after ? { after } : {}), ...(root === 1000 ? { limit: 4 } : {}) }, "team");
				assert.ok(!result.isError, result.text);
				assert.ok(result.text.length <= 16_000, `thread page has ${result.text.length} characters`);
				const covered = seenMarks(p).at(-1).covered;
				assert.ok(covered.length > 0 && covered.length <= (root === 1000 ? 4 : 50));
				for (const seq of covered) {
					assert.ok(!read.includes(seq), `message #${seq} repeated`);
					assert.ok(result.text.replace(/^ +/gm, "").includes(posts.find((m) => m.seq === seq).body), `message #${seq} body was shortened`);
				}
				read.push(...covered);
				const more = result.text.match(/More: history thread=(\d+) after=(\d+)\.$/);
				if (!more) break;
				assert.equal(Number(more[1]), root);
				assert.equal(Number(more[2]), Math.max(...covered));
				assert.ok(Number(more[2]) > after, "cursor did not advance");
				after = Number(more[2]);
			}
			assert.deepEqual(read.sort((a, b) => a - b), posts.map((m) => m.seq));
			assert.equal((await p.call({ action: "history", thread: root, after: posts.at(-1).seq }, "team")).text, "No messages.");
		}
	} finally {
		await p.close();
	}
});

await step("a team member without the extension fails its run", async () => {
	const empty = join(WORK_DIR, "empty-extension.ts");
	fs.writeFileSync(empty, "export default function () {}\n");
	const r = await run({ name: "bare", message: "SAY x", args: ["--no-extensions", "-e", empty] });
	assert.match(r.text, /^\[error\] subagent bare/);
	assert.match(r.text, /team extension did not load/);
});

// A transport error that Pi does not retry.
const DROP = "stream error: stream disconnected before completion: stream closed before response.completed";
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

await step("a provider error ends a run as an error with Pi's retry count; a running member that sent it a direct message is told, and its unread message resumes it", async () => {
	await run({ name: "erring", message: `SLOW 4000 FAIL ${DROP}`, waitMs: 0 });
	await until(() => requestsBy("erring").length > 0);
	const mark = team.events.length;
	await run({ name: "partner", message: TEAMS([{ action: "send", to: "erring", body: "SAY erring back" }, { action: "wait", ms: 60_000 }]), waitMs: 0 });
	const status = (await team.call({ action: "status", id: "erring", waitMs: 30_000 })).text;
	assert.match(status, new RegExp(`^\\[error\\] subagent erring · fake/fake-model:off · \\d+ turns · \\d+s · ${escaped(DROP)} \\(Pi retried 0 times\\)(\\n|$)`));
	const told = "[team] erring stopped on an error; the main agent was told.";
	await until(() => requestsBy("partner").some((body) => body.messages.some((m) => text(m) === told)));
	const resumed = await team.waitMessage("subagent-notice", mark);
	assert.equal(resumed.content, "[subagent] erring resumed (woken by partner) after its run ended in an error.");
	for (const id of ["erring", "partner"]) await finished(id);
});

await step("a run that a member started and that ends on an error replies to that member; the main agent gets a notice that starts no turn", async () => {
	const mark = team.events.length;
	const r = await run({ name: "caller", message: TEAMS([{ action: "send", to: "erring", body: `SLOW 1000 FAIL ${DROP}` }, { action: "wait", ms: 60_000 }]), waitMs: 60_000 });
	assert.match(r.text, /team: 1 team message\(s\) for you follow this result\./);
	const reply = text(requestsBy("caller").at(-1).messages.at(-1));
	const seq = reply.match(new RegExp(`^\\[team #(\\d+)\\] erring → you \\(direct\\):\\nFinal reply of erring \\(error\\); full text: .*final\\.md\\n\\n${escaped(DROP)}$`))?.[1] ?? assert.fail(reply);
	const notices = team.messages(mark).filter((m) => m.customType === "subagent-notice").map((m) => m.content);
	assert.deepEqual(notices, [`[subagent] erring stopped on an error; its final reply was sent to caller as team message #${seq}: ${DROP}`]);
	assert.match((await teamCall({ action: "members" })).text, /\n- erring: stopped \(error\) — test member\n/);
});

await step("a run that an extension of the member aborts ends as aborted by an extension, and a member's message still wakes it; the main agent is told", async () => {
	const selfAbort = join(WORK_DIR, "self-abort-extension.ts");
	fs.writeFileSync(
		selfAbort,
		`export default function (pi) {
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant" || !JSON.stringify(event.message.content).includes("abort me")) return;
		ctx.ui.notify("aborting myself", "warning");
		ctx.abort();
	});
}
`,
	);
	const r = await run({ name: "selfstop", message: "SAY abort me", args: ["-e", selfAbort] });
	assert.match(r.text, /^\[aborted\] subagent selfstop · fake\/fake-model:off · [^\n]* · by an extension\n\nNotices: aborting myself\n\nabort me/);
	// An extension's abort does not lock the member.
	assert.match((await teamCall({ action: "members" })).text, /\n- selfstop: stopped — test member\n/);
	assert.doesNotMatch((await team.call({ action: "status", id: "selfstop" })).text, /only your direct message wakes it/);
	const mark = team.events.length;
	const knock = await run({ name: "knock", message: TEAM({ action: "send", to: "selfstop", body: "SAY back again" }) });
	assert.match(knock.text, /team: Sent #\d+ to selfstop \(woken\)\./);
	assert.equal((await team.waitMessage("subagent-notice", mark)).content, "[subagent] selfstop resumed (woken by knock) after its run was aborted.");
	await report("selfstop", mark);
});

await step("Pi's own compaction of a member at its compact point shows in the run's result and context, with a notice that starts no turn", async () => {
	const mark = team.events.length;
	const r = await run({ name: "tiny", model: "fake/fake-small", message: "SAY tiny" });
	// fake/fake-small compacts above 1000 context tokens; one reply holds 1700.
	assert.match(r.text, /^\[settled\] subagent tiny · fake\/fake-small:off · 1 turns · \d+s · 500 in · 200 out · 1K cached · ctx ([\d.]+K?)\/1K \d+% · compacted 1\.7K→\1 \(threshold\)\n\ntiny/);
	const notices = team.messages(mark).filter((m) => m.customType === "subagent-notice");
	assert.ok(notices.length, "no compaction notice");
	for (const notice of notices) assert.match(notice.content, /^\[subagent\] tiny compacted [\d.]+K?→[\d.]+K? \(threshold\) · ctx [\d.]+K?\/1K \d+%$/);
});

const compactor = join(WORK_DIR, "compact-extension.ts");
// Takes compaction from Pi: "CANCEL" instructions cancel it and abort, "WAIT <ms>" holds it, and it ends with a fixed summary.
fs.writeFileSync(
	compactor,
	`export default function (pi) {
	pi.on("session_before_compact", async (event, ctx) => {
		const wait = Number(event.customInstructions?.match(/^WAIT (\\d+)$/)?.[1] ?? 0);
		if (wait) {
			ctx.ui.notify("compaction waits", "info");
			await new Promise((done) => {
				const timer = setTimeout(done, wait);
				event.signal.addEventListener("abort", () => (clearTimeout(timer), done()));
			});
		}
		if (event.customInstructions === "CANCEL") {
			ctx.ui.notify("compaction refused", "warning");
			ctx.abort();
			return { cancel: true };
		}
		return { compaction: { summary: "fixed summary: " + (event.customInstructions ?? ""), firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
	});
}
`,
);
/** The compaction entries in member `id`'s session. */
const compactionsOf = async (id) => {
	const dir = join((await team.request({ type: "get_state" })).data.sessionFile.replace(/\.jsonl$/, ""), "subagents", id);
	return fs
		.readdirSync(dir)
		.filter((file) => file.endsWith(".jsonl"))
		.flatMap((file) => fs.readFileSync(join(dir, file), "utf8").split("\n"))
		.filter((line) => line.includes('"type":"compaction"')).length;
};

await step("compact compacts a stopped member; an extension that takes compaction decides the summary or cancels it; with message, a member with nothing to compact runs on it", async () => {
	await run({ name: "keeper", model: "fake/fake-keep", args: ["-e", compactor], message: "SAY kept" });
	// fake/fake-keep has a 100000-token window and Pi's default 16384 reserve tokens.
	const refused = await team.call({ action: "compact", id: "keeper", instructions: "CANCEL" });
	assert.match(refused.text, /^\[error\] subagent keeper · fake\/fake-keep:off · 0 turns · \d+s · ctx 1\.7K\/83\.6K 2% · compaction failed: Compaction cancelled\n\nNotices: compaction refused(\n|$)/);
	assert.equal(await compactionsOf("keeper"), 0);
	const compacted = await team.call({ action: "compact", id: "keeper", instructions: "keep the reply" });
	assert.match(compacted.text, /^\[compacted\] subagent keeper · fake\/fake-keep:off · \d+s · ctx ([\d.]+K?)\/83\.6K \d+% · compacted 1\.7K→\1 \(manual\)(\n|$)/);
	assert.equal(await compactionsOf("keeper"), 1);
	assert.match((await teamCall({ action: "members" })).text, /\n- keeper: stopped — test member\n/);
	const continued = await team.call({ action: "compact", id: "keeper", message: "SAY continued" });
	assert.match(continued.text, /^\[settled\] subagent keeper · fake\/fake-keep:off · 1 turns · [^\n]* · Already compacted\n\ncontinued/);
});

await step("compact on a running member whose run ends before a safe point compacts it afterwards; with message, the member runs on it once compacted", async () => {
	const mark = team.events.length;
	await run({ name: "busyc", model: "fake/fake-keep", message: "SLOW 3000 SAY first", waitMs: 0 });
	const queued = await team.call({ action: "compact", id: "busyc", message: "SAY after compaction" });
	assert.match(
		queued.text,
		/^\[running\] subagent busyc [^\n]* · compacts at its next safe point\n\nIt compacts at its next safe point, once its current tool calls finish and before its next model request, then continues its run, reading your message\. If its run ends first, it compacts afterwards\./,
	);
	const again = await team.call({ action: "compact", id: "busyc" });
	assert.ok(again.isError, again.text);
	assert.match(again.text, /busyc is already compacting or has a compaction queued/);
	const done = await team.waitEvent((e) => asMessage(e)?.customType === "subagent-result" && asMessage(e).content.trimEnd().endsWith("after compaction"), mark);
	assert.match(asMessage(done).content, /^\[settled\] subagent busyc · fake\/fake-keep:off · 1 turns · [^\n]* · compacted 1\.7K→[\d.]+K? \(manual\)\n\nafter compaction/);
	assert.ok(team.messages(mark).some((m) => m.customType === "subagent-result" && /^\[settled\] subagent busyc[^\n]*\n\nfirst$/.test(m.content)), "the first run's result is missing");
	await team.waitEvent((e) => e.type === "agent_settled", team.events.indexOf(done));
});

await step("a direct message to a compacting member waits until the compaction ends; abort stops a compaction, and Pi records none", async () => {
	await run({ name: "slowc", model: "fake/fake-keep", args: ["-e", compactor], message: "SAY slowc ready" });
	const mark = team.events.length;
	assert.match((await team.call({ action: "compact", id: "slowc", instructions: "WAIT 4000", waitMs: 0 })).text, /^\[compacting\] subagent slowc /);
	assert.match((await teamCall({ action: "members" })).text, /\n- slowc: compacting — test member\n/);
	assert.match((await teamCall({ action: "send", to: "slowc", body: "SAY read afterwards" })).text, /^Sent #\d+ to slowc \(compacting; reads it afterwards\)\.$/);
	// The compaction run's result joins the session without a turn; the message then wakes the member.
	const compacted = await team.waitMessage("subagent-result", mark);
	assert.match(compacted.content, /^\[compacted\] subagent slowc · fake\/fake-keep:off · \d+s · ctx [\d.]+K?\/83\.6K \d+% · compacted 1\.7K→[\d.]+K? \(manual\)\n\nNotices: compaction waits$/);
	assert.match(await report("slowc", compacted.at + 1), /read afterwards$/);
	const before = await compactionsOf("slowc");
	await team.call({ action: "compact", id: "slowc", instructions: "WAIT 30000", waitMs: 0 });
	// Pi has started the compaction once the extension holds it.
	let progress = "";
	for (const end = Date.now() + 30_000; !progress.includes("Notices: compaction waits"); await sleep(200)) {
		if (Date.now() > end) assert.fail(progress);
		progress = (await team.call({ action: "status", id: "slowc", waitMs: 0 })).text;
	}
	const started = Date.now();
	assert.match((await team.call({ action: "abort", id: "slowc", retire: false })).text, /^\[aborted\] subagent slowc · [^\n]* · by main · only your direct message wakes it(\n|$)/);
	assert.ok(Date.now() - started < 8000, "abort waited for the kill timeout");
	assert.equal(await compactionsOf("slowc"), before);
});

await step("the main agent's direct message to a member it aborted, sent during a compaction, wakes it once the compaction ends", async () => {
	await run({ name: "lockc", model: "fake/fake-keep", args: ["-e", compactor], message: "SAY lockc ready" });
	await teamCall({ action: "send", to: "lockc", body: "HANG" });
	await until(() => requestsBy("lockc").length > 1);
	assert.match((await team.call({ action: "abort", id: "lockc", retire: false, when: "now" })).text, /^\[aborted\] subagent lockc /);
	const mark = team.events.length;
	assert.match((await team.call({ action: "compact", id: "lockc", instructions: "WAIT 3000", waitMs: 0 })).text, /^\[compacting\] subagent lockc /);
	assert.match((await teamCall({ action: "send", to: "lockc", body: "SAY unlocked" })).text, /^Sent #\d+ to lockc \(compacting; reads it afterwards\)\.$/);
	const compacted = await team.waitMessage("subagent-result", mark);
	assert.match(compacted.content, /^\[compacted\] subagent lockc /);
	assert.match(await report("lockc", compacted.at + 1), /unlocked$/);
});

/** Hires member `name` and aborts its second run, so it is locked. */
const lockedMember = async (name, args) => {
	await run({ name, model: "fake/fake-keep", args, message: `SAY ${name} ready` });
	await teamCall({ action: "send", to: name, body: "HANG" });
	await until(() => requestsBy(name).length > 1);
	assert.match((await team.call({ action: "abort", id: name, retire: false, when: "now" })).text, /^\[aborted\] /);
};
const KEPT = "KEEP this\n  word for word: #1 {x}";
const keptText = `written after the compaction for your next run:\n${KEPT}\n`;

for (const [kind, name, args] of [
	["Pi's own compaction", "keeppi", []],
	["an extension's compaction", "keepext", ["-e", compactor]],
]) {
	await step(`compact with wake false under ${kind} writes the message after the summary without a run; a locked member stays locked; its next run reads summary, message, then its messages`, async () => {
		await lockedMember(name, args);
		const before = requestsBy(name).length;
		const r = await team.call({ action: "compact", id: name, instructions: "keep the plan", message: KEPT, wake: false });
		assert.match(r.text, new RegExp(`^\\[compacted\\] subagent ${name} [^\\n]* \\(manual\\) · only your direct message wakes it\\n\\nYour message waits in its context for its next run\\.$`));
		// The member is still locked: a member's message does not wake it.
		let mark = team.events.length;
		await run({ name: `${name}-knock`, message: TEAM({ action: "send", to: name, body: "SAY knocked" }) });
		assert.match(await report(`${name}-knock`, mark), new RegExp(`Sent #\\d+ to ${name} \\(stopped, not woken: the main agent stopped it; the main agent was told\\)\\.$`));
		assert.equal(requestsBy(name).length, before, "the member ran");
		mark = team.events.length;
		assert.match((await teamCall({ action: "send", to: name, body: "SAY after keep" })).text, /\(woken\)\.$/);
		assert.match(await report(name, mark), /after keep$/);
		const seen = requestsBy(name).at(-1).messages.map(rawText);
		const context = seen.join("\n");
		const order = ["<summary>", keptText, "→ you (direct):\nSAY knocked", "→ you (direct):\nSAY after keep"].map((part) => context.indexOf(part));
		assert.ok(order[0] >= 0 && order.every((index, i) => i === 0 || index > order[i - 1]), JSON.stringify(order));
		assert.equal(context.split(keptText).length, 2, "the message is not there once");
		const summary = seen.find((m) => m.includes("<summary>"));
		// The instructions reach the compaction: Pi's summarizer prompt, or the extension that writes the summary.
		if (args.length) assert.ok(summary.includes("fixed summary: keep the plan"), summary);
		else assert.ok(requests().some((body) => body.messages.some((m) => rawText(m).includes("Additional focus: keep the plan"))), "Pi's summarizer did not get the instructions");
	});
}

await step("a member the main agent aborted and then compacted still shows that only the main agent wakes it, with its unread messages", async () => {
	await lockedMember("lockshow", ["-e", compactor]);
	assert.match((await team.call({ action: "compact", id: "lockshow" })).text, /^\[compacted\] subagent lockshow [^\n]* · only your direct message wakes it(\n|$)/);
	const mark = team.events.length;
	await run({ name: "lockknock", message: TEAM({ action: "send", to: "lockshow", body: "SAY knocked" }) });
	await report("lockknock", mark);
	assert.match((await team.call({ action: "status", id: "lockshow" })).text, /^\[compacted\] subagent lockshow [^\n]* · only your direct message wakes it, 1 unread waiting(\n|$)/);
	assert.match((await team.call({ action: "status" })).text, /^\[compacted\] subagent lockshow [^\n]* · only your direct message wakes it, 1 unread waiting$/m);
	assert.match((await teamCall({ action: "members" })).text, /\n- lockshow: stopped \(only main wakes it\) — test member\n/);
});

await step("compact with wake false writes nothing when the compaction fails, and its result starts a turn", async () => {
	await lockedMember("keepfail", ["-e", compactor]);
	const from = team.events.length;
	const r = await team.call({ action: "compact", id: "keepfail", instructions: "CANCEL", message: KEPT, wake: false, waitMs: 0 });
	assert.match(r.text, /^\[compacting\] /);
	const result = await team.waitMessage("subagent-result", from);
	assert.match(result.content, /^\[error\] subagent keepfail [^\n]* · compaction failed: Compaction cancelled · only your direct message wakes it\n\nYour message was not written to its context: no compaction completed\.\n\nNotices: compaction refused$/);
	assert.ok(team.events.slice(from, result.at).some((e) => e.type === "agent_start"), "the result started no turn");
	await team.waitEvent((e) => e.type === "agent_settled", result.at);
	const mark = team.events.length;
	await teamCall({ action: "send", to: "keepfail", body: "SAY after failure" });
	assert.match(await report("keepfail", mark), /after failure$/);
	assert.ok(!requestsBy("keepfail").at(-1).messages.some((m) => rawText(m).includes(keptText)), "the message was written");
});

await step("compact and team limits: wake false needs message, wake is for compact only, and length errors state the length; a body of 8000 characters is sent", async () => {
	for (const [args, error] of [
		[{ action: "compact", id: "keeppi", wake: false }, /compact with wake: false requires message/],
		[{ action: "status", id: "keeppi", wake: true }, /wake applies to compact only/],
		[{ action: "compact", id: "keeppi", instructions: "i".repeat(4001) }, /instructions are 4001 characters, over 4000; put what the member must keep word for word in message: with wake: true \(the default\) it runs on message once compacted; with wake: false message stays in its context and it stays stopped$/],
		[{ action: "run", name: "longrole", description: "d".repeat(101), message: "SAY x" }, /description is 101 characters, over 100/],
	]) {
		const r = await team.call(args);
		assert.ok(r.isError, r.text);
		assert.match(r.text, error);
	}
	for (const [args, error] of [
		[{ action: "send", to: "keeppi", body: "b".repeat(8001) }, /body is 8001 characters, over 8000; /],
		[{ action: "topic", body: "t".repeat(2001) }, /topic is 2001 characters, over 2000; /],
		[{ action: "topic" }, /topic requires body, which holds the topic text/],
	]) {
		const r = await teamCall(args);
		assert.ok(r.isError, r.text);
		assert.match(r.text, error);
	}
	const from = team.events.length;
	await run({ name: "longbody", message: TEAM({ action: "send", to: "main", body: "y".repeat(8000) }) });
	const note = await team.waitMessage("team-message", from);
	assert.ok(note.content.endsWith(`\n${"y".repeat(8000)}`), note.content.slice(0, 200));
	await finished("longbody");
});

const slowExit = join(WORK_DIR, "slow-exit-extension.ts");
// Holds the member's process for 3 seconds after each run ends, within the extension's 5-second kill timeout.
fs.writeFileSync(slowExit, 'export default function (pi) { pi.on("session_shutdown", () => new Promise((done) => setTimeout(done, 3000))); }\n');

await step("a member with a queued compaction is not woken between the end of its run and the compaction; an abort there locks it", async () => {
	const args = ["-e", compactor, "-e", slowExit];
	await run({ name: "gapc", model: "fake/fake-keep", args, message: "SLOW 1000 SAY gapc first", waitMs: 0 });
	assert.match((await team.call({ action: "compact", id: "gapc", instructions: "WAIT 1000" })).text, /If its run ends first, it compacts afterwards\./);
	assert.match((await team.call({ action: "status", id: "gapc", waitMs: 30_000 })).text, /^\[settled\] subagent gapc [^\n]*\n\ngapc first/);
	let mark = team.events.length;
	assert.match((await teamCall({ action: "send", to: "gapc", body: "SAY after the compaction" })).text, /^Sent #\d+ to gapc \(compacting; reads it afterwards\)\.$/);
	// The run's process has not exited, so the compaction has not started.
	assert.match((await team.call({ action: "status", id: "gapc", waitMs: 0 })).text, /^\[settled\] subagent gapc /);
	const compacted = await team.waitMessage("subagent-result", mark);
	assert.match(compacted.content, /^\[compacted\] subagent gapc /);
	assert.match(await report("gapc", compacted.at + 1), /after the compaction$/);
	// The same gap again, now ended by abort: the member is locked, and the message held for after the compaction does not wake it.
	assert.match((await teamCall({ action: "send", to: "gapc", body: "SLOW 1000 SAY gapc second" })).text, /\(woken\)\.$/);
	assert.match((await team.call({ action: "compact", id: "gapc", instructions: "WAIT 1000" })).text, /If its run ends first, it compacts afterwards\./);
	assert.match((await team.call({ action: "status", id: "gapc", waitMs: 30_000 })).text, /^\[settled\] subagent gapc [^\n]*\n\ngapc second/);
	mark = team.events.length;
	assert.match((await teamCall({ action: "send", to: "gapc", body: "SAY should not run" })).text, /\(compacting; reads it afterwards\)\.$/);
	assert.match((await team.call({ action: "abort", id: "gapc", retire: false })).text, /^\[settled\] subagent gapc /);
	const before = requestsBy("gapc").length;
	await sleep(5000);
	assert.equal(requestsBy("gapc").length, before, "the held message woke the member");
	assert.ok(!team.messages(mark).some((m) => m.customType === "subagent-result"), "a run or compaction followed the abort");
});

await step("a member's direct message to an aborted member whose process still exits tells the main agent once", async () => {
	await run({ name: "exiter", args: ["-e", slowExit], message: "HANG", waitMs: 300 });
	await run({ name: "nudger", message: TEAMS([{ action: "wait", ms: 60_000 }, { action: "send", to: "exiter", body: "SAY never" }]), waitMs: 0 });
	await until(() => requestsBy("nudger").length > 0);
	const from = team.events.length;
	assert.match((await team.call({ action: "abort", id: "exiter", retire: false, when: "now" })).text, /^\[aborted\] subagent exiter/);
	// nudger sends while exiter's process takes 3 seconds to exit, whose end routes exiter's unread messages again.
	await teamCall({ action: "send", to: "nudger", body: "go" });
	const seq = (await team.waitMessage("team-notice", from)).content.match(/^\[team\] #(\d+) nudger → exiter is waiting/)?.[1] ?? assert.fail("no notice");
	await finished("nudger");
	await sleep(4000);
	assert.equal(team.messages(from).filter((m) => m.customType === "team-notice" && m.content.startsWith(`[team] #${seq} `)).length, 1);
});

const teamMessages = async (parent) =>
	(await parent.request({ type: "get_entries" })).data.entries.filter((e) => e.type === "custom_message" && e.customType === "team-message");
const logOf = (sessionFile) => join(sessionFile.replace(/\.jsonl$/, ""), "team.jsonl");
const nextSeq = (log) =>
	Math.max(
		0,
		...fs
			.readFileSync(log, "utf8")
			.split("\n")
			.map((line) => {
				try {
					return JSON.parse(line).seq ?? 0;
				} catch {
					return 0;
				}
			}),
	) + 1;
const missed = (seq, body, from = "alpha") => `${JSON.stringify({ t: "msg", seq, at: Date.now(), from, to: ["main"], notify: ["main"], body })}\n`;
/** The team id that the first line of a team log holds. */
const teamIdOf = (log) => JSON.parse(fs.readFileSync(log, "utf8").split("\n")[0]).id;
await step("switch moves a stopped member to another model in the same session; with message, it runs on it at once", async () => {
	await run({ name: "swapper", message: "SAY swap one" });
	const r = await team.call({ action: "switch", id: "swapper", model: "fake/fake-keep", message: "SAY swap two" });
	assert.match(
		r.text,
		/^swapper now runs on fake\/fake-keep:off \(was fake\/fake-model:off\)\. ctx 1\.7K — its next request pays full input price for that context\.\n\n\[settled\] subagent swapper · fake\/fake-keep:off · 1 turns · [^\n]*\n\nswap two/,
	);
	const last = requestsBy("swapper").at(-1);
	assert.equal(last.model, "fake-keep");
	assert.ok(last.messages.some((m) => m.role === "user" && rawText(m).startsWith("SAY swap one")), "the session history is missing");
});

await step("switch on a running member whose run ends before a safe point keeps that run on the old model and applies to its next run", async () => {
	const mark = team.events.length;
	await run({ name: "runswap", message: "SLOW 5000 SAY runswap first", waitMs: 0 });
	for (const [args, error] of [
		[{ model: "fake/fake-keep", when: "now" }, /switch with when: now requires message/],
		[{ model: "fake/fake-keep", message: "SAY too soon" }, /runswap is running; with message, switch requires when: now/],
	]) {
		const refused = await team.call({ action: "switch", id: "runswap", ...args });
		assert.ok(refused.isError, refused.text);
		assert.match(refused.text, error);
	}
	const switched = await team.call({ action: "switch", id: "runswap", model: "fake/fake-keep" });
	assert.equal(switched.text, "runswap now runs on fake/fake-keep:off from its next safe point (was fake/fake-model:off).");
	assert.match((await team.call({ action: "status", id: "runswap", waitMs: 0 })).text, /^\[running\] subagent runswap [^\n]* · switches to fake\/fake-keep:off at its next safe point\n/);
	assert.equal((await team.call({ action: "switch", id: "runswap", model: "fake/fake-keep" })).text, "runswap is already set to fake/fake-keep:off.");
	assert.match(await report("runswap", mark), /^\[settled\] subagent runswap · fake\/fake-model:off · [^\n]*\n\nrunswap first/);
	assert.equal(requestFor("SLOW 5000 SAY runswap first").model, "fake-model");
	const woken = team.events.length;
	assert.match((await teamCall({ action: "send", to: "runswap", body: "SAY runswap second" })).text, /\(woken\)\.$/);
	assert.match(await report("runswap", woken), /^\[settled\] subagent runswap · fake\/fake-keep:off · [^\n]*\n\nrunswap second/);
	assert.equal(requestsBy("runswap").at(-1).model, "fake-keep");
});

await step("a wake that waits for the previous run's process to exit keeps the model it was woken with; a switch then applies to the run after it", async () => {
	await run({ name: "lateswap", args: ["-e", slowExit], message: "SAY late one" });
	// The run's process is still exiting, so the wake waits for it.
	const mark = team.events.length;
	assert.match((await teamCall({ action: "send", to: "lateswap", body: "SAY late two" })).text, /\(woken\)\.$/);
	assert.match((await team.call({ action: "switch", id: "lateswap", model: "fake/fake-keep" })).text, /^lateswap now runs on fake\/fake-keep:off from its next safe point/);
	assert.match(await report("lateswap", mark), /^\[settled\] subagent lateswap · fake\/fake-model:off · [^\n]*\n\nlate two/);
	assert.equal(requestsBy("lateswap").at(-1).model, "fake-model");
});

await step("a thinking switch keeps the member's model for its next runs, and the team log records it", async () => {
	const first = await run({ name: "thinker", model: "fake/fake-think:low", message: "SAY think one" });
	assert.match(first.text, /^\[settled\] subagent thinker · fake\/fake-think:low · /);
	assert.equal(requestsBy("thinker").at(-1).reasoning_effort, "low");
	const switched = await team.call({ action: "switch", id: "thinker", thinking: "high" });
	assert.equal(switched.text, "thinker now runs on fake/fake-think:high from its next run (was fake/fake-think:low).");
	const mark = team.events.length;
	await teamCall({ action: "send", to: "thinker", body: "SAY think two" });
	assert.match(await report("thinker", mark), /^\[settled\] subagent thinker · fake\/fake-think:high · [^\n]*\n\nthink two/);
	assert.equal(requestsBy("thinker").at(-1).reasoning_effort, "high");
	const log = logOf((await team.request({ type: "get_state" })).data.sessionFile);
	const records = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const thinker = records.filter((record) => record.t === "member" && record.name === "thinker");
	assert.deepEqual(thinker.at(-1).args.slice(4), ["--model", "fake/fake-think", "--thinking", "high"]);
	const refused = await team.call({ action: "switch", id: "thinker" });
	assert.ok(refused.isError && /switch requires model or thinking/.test(refused.text), refused.text);
	assert.equal((await team.call({ action: "switch", id: "thinker", thinking: "high" })).text, "thinker is already set to fake/fake-think:high.");
});

const stall = join(WORK_DIR, "stall-extension.ts");
// Holds every tool call for 15 seconds, deaf to an abort, so stopping the run takes the 10-second kill.
fs.writeFileSync(stall, 'export default function (pi) { pi.on("tool_call", () => new Promise((done) => setTimeout(done, 15000))); }\n');

await step("switch now stops a running member and runs it on message with the new settings in one call; a member's direct message during the stop reaches the new run", async () => {
	await run({ name: "hotswap", args: ["-e", stall], message: "BASH echo stalled", waitMs: 0 });
	await until(() => requestsBy("hotswap").length > 0);
	// A switch from its next run first: the result's `was` names the model the run actually uses.
	await team.call({ action: "switch", id: "hotswap", model: "fake/fake-keep" });
	const from = team.events.length;
	// poker sends while the switch call waits for the stalled run to be killed.
	await run({ name: "poker", message: `SLOW 4000 ${TEAM({ action: "send", to: "hotswap", body: "poked" })}`, waitMs: 0 });
	const r = await team.call({ action: "switch", id: "hotswap", model: "fake/fake-think:high", when: "now", message: "SAY hot", waitMs: 0 });
	assert.match(r.text, /^hotswap now runs on fake\/fake-think:high \(was fake\/fake-model:off\)\.[^\n]*\n\n\[aborted\] subagent hotswap [^\n]* · by main\n\n\[running\] subagent hotswap /);
	await finished("poker");
	assert.match(rawText(requestsBy("poker").at(-1).messages.findLast((m) => m.role === "tool")), /^Sent #\d+ to hotswap \(running\)\.$/);
	assert.match(await report("hotswap", from), /^\[settled\] subagent hotswap · fake\/fake-think:high · [^\n]*\n\nhot$/);
	await sleep(1000);
	const last = requestsBy("hotswap").at(-1);
	assert.equal(last.model, "fake-think");
	assert.equal(last.messages.filter((m) => rawText(m).includes("poker → you (direct):\npoked\n")).length, 1, "the new run did not read the message once");
	const about = team.messages(from).filter((m) => m.content.includes("hotswap"));
	assert.ok(!about.some((m) => m.customType === "team-notice" || m.customType === "subagent-notice"), about.map((m) => m.content).join("\n"));
	// One run after the stop, with one request, and the stopped run's result only in the switch result.
	assert.equal(requestsBy("hotswap").filter((body) => body.model !== "fake-model").length, 1, "hotswap ran more than once");
	assert.ok(!about.some((m) => m.customType === "subagent-result" && /^\[aborted\]/.test(m.content)), "the stopped run's result was delivered again");
});

await step("Esc during switch now leaves the member aborted on the new settings without running it; a member's direct message does not wake it", async () => {
	await run({ name: "escswap", args: ["-e", stall], message: "BASH echo stalled", waitMs: 0 });
	await until(() => requestsBy("escswap").length > 0);
	const from = team.events.length;
	team.prompt(`CALL ${JSON.stringify({ action: "switch", id: "escswap", model: "fake/fake-think:high", when: "now", message: "SAY should not run", waitMs: 0 })}`);
	await team.waitEvent((e) => e.type === "tool_execution_start" && e.toolName === "subagent", from);
	await sleep(1000);
	team.send({ type: "clear_queue" });
	team.send({ type: "abort" });
	const end = await team.waitEvent((e) => e.type === "tool_execution_end" && e.toolName === "subagent", from);
	assert.match(
		end.result.content[0].text,
		/^escswap now runs on fake\/fake-think:high from its next run \(was fake\/fake-model:off\)\.[^\n]* The call was cancelled, so it stopped without running on message\.\n\n\[aborted\] subagent escswap [^\n]* · by main/,
	);
	await team.waitEvent((e) => e.type === "agent_settled", team.events.indexOf(end));
	assert.match((await teamCall({ action: "members" })).text, /\n- escswap: stopped \(only main wakes it\) — test member\n/);
	const mark = team.events.length;
	await run({ name: "escknock", message: TEAM({ action: "send", to: "escswap", body: "SAY woke" }) });
	assert.match(await report("escknock", mark), /team: Sent #\d+ to escswap \(stopped, not woken: the main agent stopped it; the main agent was told\)\.$/);
	await sleep(2000);
	assert.ok(requestsBy("escswap").every((body) => body.model === "fake-model"), "escswap ran after the cancelled switch");
});

await step("compact now stops a running member and compacts it in one call; a member's direct message during the stop is routed after the compaction", async () => {
	await run({ name: "nowc", model: "fake/fake-keep", args: ["-e", stall, "-e", compactor], message: "BASH echo stalled", waitMs: 0 });
	await until(() => requestsBy("nowc").length > 0);
	const from = team.events.length;
	// nowpoker sends while the compact call waits for the stalled run to be killed, then waits for nowc's reply, so no result ends that call early.
	await run({ name: "nowpoker", message: `SLOW 4000 ${TEAMS([{ action: "send", to: "nowc", body: "SAY after now" }, { action: "wait", ms: 60_000 }])}`, waitMs: 0 });
	const before = await compactionsOf("nowc");
	const r = await team.call({ action: "compact", id: "nowc", when: "now", instructions: "keep it", waitMs: 60_000 });
	assert.match(r.text, /^\[aborted\] subagent nowc [^\n]* · by main\n\n\[compacted\] subagent nowc · /);
	assert.equal(await compactionsOf("nowc"), before + 1);
	// The message woke nowc once the compaction ended, and its final reply went back to nowpoker.
	await finished("nowpoker");
	const seen = requestsBy("nowpoker").at(-1).messages.map(rawText);
	assert.ok(seen.some((m) => /^Sent #\d+ to nowc \(running\)\.$/.test(m)), "the message did not find nowc running");
	assert.ok(seen.some((m) => /nowc → you \(direct\):\nFinal reply of nowc \(settled\)[^]*\n\nafter now\n/.test(m)), "nowc's reply is missing");
	assert.ok(!team.messages(from).some((m) => m.customType === "team-notice" && m.content.includes("nowc's inbox")), "a stuck-message notice");
});

await step("compact now with wake false writes the message after the summary and leaves the member stopped", async () => {
	await run({ name: "nowkeep", model: "fake/fake-keep", args: ["-e", stall, "-e", compactor], message: "BASH echo stalled", waitMs: 0 });
	await until(() => requestsBy("nowkeep").length > 0);
	const r = await team.call({ action: "compact", id: "nowkeep", when: "now", message: KEPT, wake: false, waitMs: 60_000 });
	assert.match(r.text, /^\[aborted\] subagent nowkeep [^\n]* · by main\n\n\[compacted\] subagent nowkeep [^\n]*\n\nYour message waits in its context for its next run\.$/);
	const before = requestsBy("nowkeep").length;
	await sleep(1000);
	assert.equal(requestsBy("nowkeep").length, before, "the member ran");
	const mark = team.events.length;
	await teamCall({ action: "send", to: "nowkeep", body: "SAY kept now" });
	assert.match(await report("nowkeep", mark), /kept now$/);
	assert.equal(requestsBy("nowkeep").at(-1).messages.map(rawText).join("\n").split(keptText).length, 2, "the message is not there once");
});

await step("Esc during compact now starts no compaction and leaves the member locked", async () => {
	await run({ name: "escc", args: ["-e", stall, "-e", compactor], message: "BASH echo stalled", waitMs: 0 });
	await until(() => requestsBy("escc").length > 0);
	const before = await compactionsOf("escc");
	const from = team.events.length;
	team.prompt(`CALL ${JSON.stringify({ action: "compact", id: "escc", when: "now", message: "SAY should not run", waitMs: 0 })}`);
	await team.waitEvent((e) => e.type === "tool_execution_start" && e.toolName === "subagent", from);
	await sleep(1000);
	team.send({ type: "clear_queue" });
	team.send({ type: "abort" });
	const end = await team.waitEvent((e) => e.type === "tool_execution_end" && e.toolName === "subagent", from);
	assert.match(
		end.result.content[0].text,
		/^escc: the call was cancelled, so it stopped without compacting\.\n\n\[aborted\] subagent escc [^\n]* · by main · only your direct message wakes it(\n|$)/,
	);
	await team.waitEvent((e) => e.type === "agent_settled", team.events.indexOf(end));
	await sleep(2000);
	assert.equal(await compactionsOf("escc"), before);
	assert.match((await teamCall({ action: "members" })).text, /\n- escc: stopped \(only main wakes it\) — test member\n/);
});

/** Hires member `name` on a team wait of a minute and waits until it is in that wait, past its first model request. */
const waiting = async (name, args = {}) => {
	await run({ name, message: TEAMS([{ action: "wait", ms: 60_000 }, { action: "members" }]), waitMs: 0, ...args });
	await until(() => requestsBy(name).length > 0);
	await sleep(1500);
};
/** Member `id`'s next result from event index `from`, once the main agent's turn on it has ended. */
const resultOf = async (id, from) => {
	const result = await team.waitEvent((e) => asMessage(e)?.customType === "subagent-result" && asMessage(e).details?.id === id, from);
	await team.waitEvent((e) => e.type === "agent_settled", team.events.indexOf(result));
	return asMessage(result).content.trimEnd();
};

await step("abort stops a running member at its next safe point: a member in team wait returns from it early and makes no model request after it; a timed-out wait shows the team", async () => {
	await waiting("safeab");
	const shown = (await teamCall({ action: "wait", ms: 500 })).text;
	// Busy members come first; stopped ones that need the main agent follow.
	assert.match(shown, /^No messages for you within 500ms\.\n\nTeam:\n(- \S+ (running|compacting) [^\n]*\n)*- safeab running \d+s · team \d+s · last event \d+s ago · ctx [^\n]*\n- \S+ stopped · /);
	const from = team.events.length;
	const started = Date.now();
	const r = await team.call({ action: "abort", id: "safeab", retire: false });
	assert.match(
		r.text,
		/^\[running\] subagent safeab [^\n]* · stops at its next safe point\n\nIt stops at its next safe point, once its current tool calls finish and before its next model request; its result arrives then\./,
	);
	assert.match(await resultOf("safeab", from), /^\[aborted\] subagent safeab [^\n]* · by main · only your direct message wakes it/);
	assert.ok(Date.now() - started < 30_000, "the wait was not cut short");
	assert.equal(requestsBy("safeab").length, 1, "the member made a model request after its safe point");
	// A member's wait that times out names the others' states, and says when only main can bring news.
	const mark = team.events.length;
	await run({ name: "alone", message: TEAM({ action: "wait", ms: 300 }), waitMs: 0 });
	assert.match(
		await report("alone", mark),
		/team: No team messages for you within 300ms\.\n\nTeam: [^\n]*\bsafeab stopped\b[^\n]*\.\nNo other member is running; only main can bring new messages\. If your work is done, end your run with your final reply\.$/,
	);
});

await step("the main agent's direct message sent while an abort waits for the member's safe point wakes it once the run has stopped, ahead of a member's earlier message", async () => {
	// A slow tool holds the safe point back while a member and then the main agent send.
	await run({ name: "abortdm", message: "BASH sleep 10", waitMs: 0 });
	await until(() => requestsBy("abortdm").length > 0);
	const from = team.events.length;
	assert.match((await team.call({ action: "abort", id: "abortdm", retire: false })).text, / · stops at its next safe point\n/);
	await run({ name: "abortpeer", message: TEAM({ action: "send", to: "abortdm", body: "SAY from peer" }), waitMs: 0 });
	assert.match(await report("abortpeer", from), /\nteam: Sent #\d+ to abortdm \(running\)\.(\n|$)/);
	assert.match((await teamCall({ action: "send", to: "abortdm", body: "SAY rewoken" })).text, /^Sent #\d+ to abortdm \(running\)\.$/);
	const aborted = await resultOf("abortdm", from);
	assert.match(aborted, /^\[aborted\] subagent abortdm [^\n]* · by main(\n|$)/);
	assert.doesNotMatch(aborted, /only your direct message wakes it/);
	const woken = await team.waitEvent((e) => asMessage(e)?.customType === "subagent-result" && asMessage(e).details?.id === "abortdm" && asMessage(e).content.trimEnd().endsWith("rewoken"), from);
	// The run the main agent's message started reports to it.
	assert.match(asMessage(woken).content.trimEnd(), /^\[settled\] subagent abortdm [^\n]*\n\nrewoken$/);
	await team.waitEvent((e) => e.type === "agent_settled", team.events.indexOf(woken));
	assert.ok(!team.messages(from).some((m) => m.customType === "team-notice" && m.content.includes("abortdm's inbox")), "the message was reported stuck");
});

await step("compact at a running member's next safe point compacts it within its run, which then continues on the main agent's message; the main agent gets a notice", async () => {
	await waiting("safec", { model: "fake/fake-keep" });
	const before = await compactionsOf("safec");
	const from = team.events.length;
	const r = await team.call({ action: "compact", id: "safec", instructions: "keep safec", message: "SAY resumed" });
	assert.match(r.text, /^\[running\] subagent safec [^\n]* · compacts at its next safe point\n\nIt compacts at its next safe point, [^\n]*, then continues its run, reading your message\./);
	assert.match(await resultOf("safec", from), /^\[settled\] subagent safec · fake\/fake-keep:off · \d+ turns · [^\n]* · compacted [\d.]+K?→[\d.]+K? \(manual\)\n\nresumed$/);
	assert.ok(
		team.messages(from).some((m) => m.customType === "subagent-notice" && /^\[subagent\] safec compacted [\d.]+K?→[\d.]+K? \(manual\) · ctx [^\n]* at its safe point; it continues its run\.$/.test(m.content)),
		"no notice of the compaction",
	);
	assert.equal(await compactionsOf("safec"), before + 1);
	assert.ok(requests().some((body) => body.messages.some((m) => rawText(m).includes("Additional focus: keep safec"))), "the instructions did not reach the compaction");
	assert.ok(requestsBy("safec").at(-1).messages.some((m) => rawText(m).includes("<summary>")), "the run did not continue on the compacted context");
});

await step("switch at a running member's next safe point changes the model of the run it is in", async () => {
	await waiting("safesw");
	const from = team.events.length;
	assert.equal(
		(await team.call({ action: "switch", id: "safesw", model: "fake/fake-think:high" })).text,
		"safesw now runs on fake/fake-think:high from its next safe point (was fake/fake-model:off). ctx 1.7K — its next request pays full input price for that context.",
	);
	assert.match(await resultOf("safesw", from), /^\[settled\] subagent safesw · fake\/fake-think:high · 3 turns · [^\n]*\n\nteam: Members:/);
	const [first, ...later] = requestsBy("safesw");
	assert.equal(first.model, "fake-model");
	assert.equal(later.length, 2);
	for (const body of later) assert.deepEqual([body.model, body.reasoning_effort], ["fake-think", "high"]);
	assert.ok(team.messages(from).some((m) => m.content === "[subagent] safesw switched to fake/fake-think:high at its safe point."), "no notice of the switch");
});

await step("a safe-point switch matches models as Pi does, and a thinking switch keeps the run's model", async () => {
	await waiting("fuzzy", { model: "fake-think:low" });
	const from = team.events.length;
	assert.match((await team.call({ action: "switch", id: "fuzzy", thinking: "high" })).text, /^fuzzy now runs on fake-think:high from its next safe point \(was fake\/fake-think:low\)\./);
	await resultOf("fuzzy", from);
	const [first, ...later] = requestsBy("fuzzy");
	assert.equal(first.reasoning_effort, "low");
	assert.equal(later.length, 2);
	for (const body of later) assert.deepEqual([body.model, body.reasoning_effort], ["fake-think", "high"]);
	assert.ok(team.messages(from).some((m) => m.content === "[subagent] fuzzy switched to fake/fake-think:high at its safe point."), "no notice of the switch");
});

await step("a safe-point switch names the thinking level Pi set when Pi fits the asked level to the model", async () => {
	// fake/fake-model does not reason, so Pi turns any level off.
	await waiting("clampsw");
	const from = team.events.length;
	await team.call({ action: "switch", id: "clampsw", thinking: "high" });
	await resultOf("clampsw", from);
	assert.ok(
		team.messages(from).some((m) => m.content === "[subagent] clampsw switched to fake/fake-model:off at its safe point; Pi fits high to the levels the model supports."),
		team.messages(from).map((m) => m.content).join("\n"),
	);
});

await step("a switch that arrives while another applies at a safe point applies at the next safe point", async () => {
	const slowSelect = join(WORK_DIR, "slow-select-extension.ts");
	fs.writeFileSync(slowSelect, 'export default function (pi) { pi.on("model_select", () => new Promise((done) => setTimeout(done, 3000))); }\n');
	await waiting("race", { args: ["-e", slowSelect] });
	const from = team.events.length;
	await team.call({ action: "switch", id: "race", model: "fake/fake-keep" });
	await team.call({ action: "switch", id: "race", model: "fake/fake-think" });
	assert.match(await resultOf("race", from), /^\[settled\] subagent race · fake\/fake-think:off · 3 turns · /);
	assert.deepEqual(requestsBy("race").map((body) => body.model), ["fake-model", "fake-keep", "fake-think"]);
	const notices = team.messages(from).filter((m) => m.content.startsWith("[subagent] race ")).map((m) => m.content);
	assert.deepEqual(notices, ["[subagent] race switched to fake/fake-keep:off at its safe point.", "[subagent] race switched to fake/fake-think:off at its safe point."]);
});

await step("a safe-point switch finds a model among the member's own models", async () => {
	const provider = join(WORK_DIR, "child-provider-extension.ts");
	const model = (id) => ({ id, name: id, api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 });
	const config = { baseUrl: "http://127.0.0.1:8787/v1", api: "openai-completions", apiKey: "x", models: [model("child-one"), model("child-two")] };
	fs.writeFileSync(provider, `export default function (pi) { pi.registerProvider("child-only", ${JSON.stringify(config)}); }\n`);
	await waiting("catalog", { model: "child-only/child-one", args: ["-e", provider] });
	const from = team.events.length;
	await team.call({ action: "switch", id: "catalog", model: "child-only/child-two" });
	await resultOf("catalog", from);
	assert.deepEqual(requestsBy("catalog").map((body) => body.model), ["child-one", "child-two", "child-two"]);
	assert.ok(team.messages(from).some((m) => m.content.startsWith("[subagent] catalog switched to child-only/child-two")), "no notice of the switch");
});

await step("a member compacts at two safe points of one run", async () => {
	await waiting("twicec", { model: "fake/fake-keep" });
	const before = await compactionsOf("twicec");
	const from = team.events.length;
	await team.call({ action: "compact", id: "twicec", message: TEAMS([{ action: "wait", ms: 60_000 }, { action: "members" }]) });
	await until(() => requestsBy("twicec").length > 1);
	await sleep(1500);
	await team.call({ action: "compact", id: "twicec", message: "SAY twice" });
	assert.match(await resultOf("twicec", from), /^\[settled\] subagent twicec [^\n]* · compacted [\d.]+K?→[\d.]+K? \(manual\)\n\ntwice$/);
	assert.equal((await compactionsOf("twicec")) - before, 2);
});

await step("a safe-point compaction with nothing to compact lets the run continue and says so", async () => {
	await waiting("noopc");
	const from = team.events.length;
	await team.call({ action: "compact", id: "noopc", message: "SAY still here" });
	assert.match(await resultOf("noopc", from), /^\[settled\] subagent noopc [^\n]* · Nothing to compact[^\n]*\n\nstill here$/);
	assert.ok(
		team.messages(from).some((m) => /^\[subagent\] noopc Nothing to compact[^\n]* at its safe point; it continues its run\.$/.test(m.content)),
		"no notice of the empty compaction",
	);
});

await step("a compaction and a switch pending at the same safe point compact on the new model, and the run continues on it", async () => {
	await run({ name: "combo", model: "fake/fake-think:low", message: "BASH sleep 6", waitMs: 0 });
	await until(() => requestsBy("combo").length > 0);
	const from = team.events.length;
	await team.call({ action: "compact", id: "combo", message: "SAY combined" });
	assert.match((await team.call({ action: "switch", id: "combo", model: "fake-keep" })).text, /^combo now runs on fake-keep:low from its next safe point/);
	assert.match(await resultOf("combo", from), /^\[settled\] subagent combo · fake\/fake-keep:\w+ · [^\n]* · compacted [\d.]+K?→[\d.]+K? \(manual\)\n\ncombined$/);
	assert.equal(requestsBy("combo").length, 2);
	assert.equal(requestsBy("combo").at(-1).model, "fake-keep");
});

await step("a compaction an extension cancels at a member's safe point ends its run in an error without continuing it", async () => {
	await waiting("cancelc", { model: "fake/fake-keep", args: ["-e", compactor] });
	const from = team.events.length;
	await team.call({ action: "compact", id: "cancelc", instructions: "CANCEL", message: "SAY should not run" });
	assert.match(await resultOf("cancelc", from), /^\[error\] subagent cancelc [^\n]* · compaction failed: Compaction cancelled(\n|$)/);
	assert.equal(requestsBy("cancelc").length, 1, "the run continued after the failed compaction");
	assert.ok(!team.messages(from).some((m) => m.customType === "subagent-notice" && m.content.includes("cancelc")), "the failure was also sent as a notice");
});

await step("a member whose process exits during the compaction at its safe point ends its run in an error and is not left running", async () => {
	const quitter = join(WORK_DIR, "quit-extension.ts");
	fs.writeFileSync(quitter, 'export default function (pi) { pi.on("agent_settled", (event, ctx) => { if (event.aborted) ctx.shutdown(); }); }\n');
	await waiting("quitc", { model: "fake/fake-keep", args: ["-e", quitter] });
	const from = team.events.length;
	await team.call({ action: "compact", id: "quitc" });
	assert.match(await resultOf("quitc", from), /^\[error\] subagent quitc [^\n]* · the process exited during the compaction at its safe point: Pi exited /);
	assert.match((await team.call({ action: "status", id: "quitc", waitMs: 0 })).text, /^\[error\] subagent quitc /);
});

await step("a team message the main agent sends, and the join it reads, through another tool are not delivered again when the session reopens", async () => {
	const relay = join(WORK_DIR, "relay-extension.ts");
	// Runs another tool, as codemode does: the nested call's details never reach the session.
	fs.writeFileSync(
		relay,
		`export default function (pi) {
	pi.registerTool({
		name: "relay",
		label: "Relay",
		description: "Runs another tool.",
		parameters: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" } }, required: ["tool", "args"] },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const outcome = await ctx.executeTool(params.tool, params.args);
			return { content: [{ type: "text", text: JSON.stringify(outcome).slice(0, 2000) }], details: undefined };
		},
	});
}
`,
	);
	const p = startParent(["--session-dir", join(WORK_DIR, "relay-sessions"), "-e", relay]);
	current = p;
	let session;
	try {
		const through = (tool, args) => p.say(`TOOL relay ${JSON.stringify({ tool, args })}`);
		await through("subagent", { action: "run", name: "relayed", description: ROLE, message: "SAY relayed done", waitMs: 30_000 });
		await through("team", { action: "send", title: "sent through relay", body: "sent through relay" });
		const toolResults = p.events.filter((e) => e.type === "tool_execution_end" && e.toolName === "relay").map((e) => e.result.content[0].text);
		assert.match(toolResults[0], /relayed done/);
		assert.match(toolResults[1], /Posted #2\./);
		session = (await p.request({ type: "get_state" })).data.sessionFile;
	} finally {
		await p.close();
	}
	const reopened = startParent(["--session", session, "-e", relay]);
	current = reopened;
	try {
		await sleep(1500);
		assert.deepEqual(reopened.messages().map((m) => m.content), [], "the reopened session got messages again");
	} finally {
		await reopened.close();
	}
});

const FORK_NOTICE =
	"[team] The team messages above belong to the team of the session this one was forked from. This session has a team of its own, which starts without members; resume the original session to work with that team.";
let teamSession;

await step("resuming the session restores members as stopped and delivers only missing messages", async () => {
	teamSession = (await team.request({ type: "get_state" })).data.sessionFile;
	const delivered = (await teamMessages(team)).length;
	await team.close();
	const seq = nextSeq(logOf(teamSession));
	fs.appendFileSync(logOf(teamSession), missed(seq, "missed while away"));
	const before = requests().length;
	const resumed = startParent(["--session", teamSession]);
	current = resumed;
	try {
		const restored = await teamMessages(resumed);
		assert.equal(restored.length, delivered + 1);
		assert.equal(new Set(restored.map((e) => e.details.seq)).size, restored.length, "a message was delivered twice");
		assert.match(restored.find((e) => e.details.seq === seq).content, /^\[team #\d+\] alpha → you \(direct\):\nmissed while away/);
		await sleep(1000);
		assert.ok(!resumed.events.some((e) => e.type === "agent_start"), "restoring started a turn");
		const status = await resumed.call({ action: "status" });
		for (const line of status.text.split("\n")) assert.match(line, /^\[stopped\] subagent [a-z-]+$/);
		assert.match(status.text, /alpha/);
		assert.doesNotMatch(status.text, /retiree/);
		assert.ok(!requests().slice(before).some((body) => body.messages.some((m) => rawText(m).startsWith("[team] You are"))), "a member started");
	} finally {
		await resumed.close();
	}
});

await step("a reopened session runs a switched member on its new model", async () => {
	const reopened = startParent(["--session", teamSession]);
	current = reopened;
	try {
		const mark = reopened.events.length;
		assert.match((await reopened.call({ action: "send", to: "swapper", body: "SAY swap three" }, "team")).text, /\(woken\)\.$/);
		const result = await reopened.waitMessage("subagent-result", mark);
		assert.match(result.content, /^\[settled\] subagent swapper · fake\/fake-keep:off · [^\n]*\n\nswap three$/);
		await reopened.waitEvent((e) => e.type === "agent_settled", result.at);
		assert.equal(requestsBy("swapper").at(-1).model, "fake-keep");
	} finally {
		await reopened.close();
	}
});

await step("a torn last line in the team log does not swallow the next record", async () => {
	const seq = nextSeq(logOf(teamSession));
	fs.appendFileSync(logOf(teamSession), '{"t":"msg","seq":');
	for (const check of [
		async (parent) => assert.match((await parent.call({ action: "send", title: "after the tear", body: "after the tear" }, "team")).text, new RegExp(`^Posted #${seq}\\.`)),
		async (parent) => assert.equal((await parent.call({ action: "history", query: "after the tear" }, "team")).text, `[team #${seq}] you → #team: after the tear\nafter the tear`),
	]) {
		const reopened = startParent(["--session", teamSession]);
		current = reopened;
		try {
			await check(reopened);
		} finally {
			await reopened.close();
		}
	}
});

await step("a team started in a clone restores its own messages despite the original team's", async () => {
	const original = startParent(["--session", teamSession]);
	current = original;
	let clone;
	try {
		// The clone's first message for main is #2, after alpha's join announcement; the clone inherits higher seqs of the original team.
		assert.ok((await teamMessages(original)).some((e) => e.details.seq >= 2), "the original team delivered nothing to inherit");
		assert.equal((await original.request({ type: "clone" })).data.cancelled, false);
		clone = (await original.request({ type: "get_state" })).data;
		assert.notEqual(clone.sessionFile, teamSession);
		const { entries, leafId } = (await original.request({ type: "get_entries" })).data;
		assert.equal(entries.find((e) => e.id === leafId).content.trimEnd(), FORK_NOTICE);
		// alpha belongs to the original team, so hiring it again proves the clone has a team of its own.
		assert.match((await original.call({ action: "run", name: "alpha", message: "SAY cloned" })).text, /^\[settled\] subagent alpha/);
	} finally {
		await original.close();
	}
	fs.appendFileSync(logOf(clone.sessionFile), missed(2, "first in the clone"));
	const reopened = startParent(["--session", clone.sessionFile]);
	current = reopened;
	try {
		const restored = (await teamMessages(reopened)).filter((e) => e.details.team === teamIdOf(logOf(clone.sessionFile)));
		assert.deepEqual(
			restored.map((e) => [e.details.seq, e.content.trimEnd()]),
			[[2, "[team #2] alpha → you (direct):\nfirst in the clone"]],
		);
	} finally {
		await reopened.close();
	}
});

await step("an imported copy of a session, which keeps the session id, starts a team of its own", async () => {
	// What import does: the same file under another name.
	const copy = teamSession.replace(/\.jsonl$/, "-imported.jsonl");
	fs.copyFileSync(teamSession, copy);
	const opened = startParent(["--session", copy]);
	current = opened;
	try {
		assert.match((await opened.call({ action: "send", title: "first in the copy", body: "first in the copy" }, "team")).text, /^Posted #1\./);
	} finally {
		await opened.close();
	}
	fs.appendFileSync(logOf(copy), missed(2, "for main in the copy"));
	const reopened = startParent(["--session", copy]);
	current = reopened;
	try {
		// The copy holds the original team's messages up to a higher seq, under the same session id.
		const restored = (await teamMessages(reopened)).filter((e) => e.content.includes("in the copy"));
		assert.deepEqual(
			restored.map((e) => [e.details.team, e.details.seq, e.content.trimEnd()]),
			[[teamIdOf(logOf(copy)), 2, "[team #2] alpha → you (direct):\nfor main in the copy"]],
		);
		assert.notEqual(teamIdOf(logOf(copy)), teamIdOf(logOf(teamSession)));
	} finally {
		await reopened.close();
	}
});

await step("board posts an agent missed before its session closed show in its digest after the session is reopened", async () => {
	const opened = startParent(["--session", teamSession]);
	current = opened;
	let forRomeo;
	try {
		const from = opened.events.length;
		await opened.call({ action: "run", name: "romeo", message: "SAY romeo ready" });
		assert.ok(!opened.messages(from).some((m) => m.customType === "team-notice"), "the reopened main agent got a digest of posts it had seen");
		forRomeo = Number((await opened.call({ action: "send", title: "missed by romeo", body: "missed by romeo" }, "team")).text.match(/^Posted #(\d+)\./)[1]);
	} finally {
		await opened.close();
	}
	const forMain = forRomeo + 1;
	fs.appendFileSync(logOf(teamSession), `${JSON.stringify({ t: "msg", seq: forMain, at: Date.now(), from: "alpha", to: "team", notify: [], title: "missed by main", body: "missed by main" })}\n`);
	// sam, hired by the closed session as romeo was, with its join announcement; the reload finds that post by its title.
	const sam = JSON.parse(fs.readFileSync(logOf(teamSession), "utf8").split("\n").find((line) => line.startsWith('{"t":"member","name":"romeo"')).replaceAll("romeo", "sam"));
	const samJoined = `joined: sam — ${sam.description}`;
	fs.appendFileSync(
		logOf(teamSession),
		`${JSON.stringify(sam)}\n${JSON.stringify({ t: "msg", seq: forMain + 1, at: Date.now(), from: "main", to: "team", notify: [], title: samJoined, body: samJoined })}\n`,
	);
	const reopened = startParent(["--session", teamSession]);
	current = reopened;
	try {
		const from = reopened.events.length;
		await reopened.call({ action: "members" }, "team");
		assert.deepEqual(
			reopened.messages(from).filter((m) => m.customType === "team-notice").map((m) => m.content),
			[`[team] Board: 1 new post — #${forMain} alpha: missed by main (team history).`],
		);
		const mark = reopened.events.length;
		assert.match((await reopened.call({ action: "send", to: "romeo", body: "SAY romeo woken" }, "team")).text, /\(woken\)\.$/);
		const result = await reopened.waitMessage("subagent-result", mark);
		await reopened.waitEvent((e) => e.type === "agent_settled", result.at);
		assert.match(
			text(requestsBy("romeo").at(-1).messages.at(-1)),
			new RegExp(`main → you \\(direct\\):\\nSAY romeo woken\\n\\n\\[team\\] Board: 3 new posts — #${forRomeo} main: missed by romeo; #${forMain} alpha: missed by main; #${forMain + 1} main: ${samJoined} \\(team history\\)\\.$`),
		);
		// sam's first digest lists the latest posts without its own join announcement, the newest.
		const woken = reopened.events.length;
		assert.match((await reopened.call({ action: "send", to: "sam", body: "SAY sam woken" }, "team")).text, /\(woken\)\.$/);
		await reopened.waitEvent((e) => e.type === "agent_settled", (await reopened.waitMessage("subagent-result", woken)).at);
		assert.match(
			text(requestsBy("sam").at(-1).messages.at(-1)),
			new RegExp(`main → you \\(direct\\):\\nSAY sam woken\\n\\n\\[team\\] Board: \\d+ new posts in \\d+ threads — [^\\n]*#${forMain} alpha: missed by main; \\+\\d+ earlier \\(team history before=\\d+\\)\\.$`),
		);
	} finally {
		await reopened.close();
	}
});

const treeArgs = ["--no-extensions", "-e", fileURLToPath(new URL("..", import.meta.url)), "-e", busyExtension];
/** The current branch of `p`'s session, root first, and its leaf. */
const branchOf = async (p) => {
	const { entries, leafId } = (await p.request({ type: "get_entries" })).data;
	const byId = new Map(entries.map((e) => [e.id, e]));
	const branch = [];
	for (let e = byId.get(leafId); e; e = byId.get(e.parentId)) branch.unshift(e);
	return { branch, leafId };
};
/** The entries the branch holds after entry `id`, as [customType or type, text]. */
const after = (branch, id) =>
	branch.slice(branch.findIndex((e) => e.id === id) + 1).map((e) => [e.customType ?? e.type, typeof e.content === "string" ? e.content.trimEnd() : ""]);
/** Moves `p` to entry `id` of its session tree, summarizing the abandoned branch after `ms` if given. */
const treeTo = async (p, id, ms) => {
	const from = p.events.length;
	p.prompt(`/tree-to ${id}${ms === undefined ? "" : ` ${ms}`}`);
	return p.waitEvent((e) => e.type === "extension_ui_request" && e.message === `navigated to ${id}`, from, 90_000);
};
/** The seqs of team-message entries on `branch`. */
const delivered = (branch) => branch.filter((e) => e.customType === "team-message").map((e) => e.details.seq);
/** Waits for `p`'s next subagent-result from event index `from` and the end of the run it starts or joins. */
const resultArrives = async (p, from) => {
	const result = await p.waitMessage("subagent-result", from);
	await p.waitEvent((e) => e.type === "agent_settled", result.at);
	return result;
};
const treeSessions = join(WORK_DIR, "tree-sessions");
let treeSession;
let treeStart;
let treeEnd;

await step("after a rewind in the session tree, the main agent quietly gets the team messages and results the branch lacks, its own included, and none twice", async () => {
	const tree = startParent(["--session-dir", treeSessions, ...treeArgs]);
	current = tree;
	try {
		await tree.say("SAY start");
		treeStart = (await branchOf(tree)).leafId;
		treeSession = (await tree.request({ type: "get_state" })).data.sessionFile;
		assert.match((await tree.call({ action: "run", name: "tango", message: "SAY tango done" })).text, /tango done$/);
		const from = tree.events.length;
		await tree.call({ action: "run", name: "uniform", message: TEAM({ action: "send", to: "main", body: "for main" }) });
		await resultArrives(tree, from);
		assert.match((await tree.call({ action: "send", title: "main's plan", body: "main's plan" }, "team")).text, /^Posted #4\./);
		const { branch, leafId } = await branchOf(tree);
		treeEnd = leafId;
		assert.equal(branch.at(-1).message?.role, "assistant");
		const mark = tree.events.length;
		await treeTo(tree, treeStart);
		const back = after((await branchOf(tree)).branch, treeStart);
		assert.deepEqual(back.slice(0, 4), [
			["team-message", "[team #1] you → #team: joined: tango — test member\njoined: tango — test member"],
			["team-message", "[team #2] you → #team: joined: uniform — test member\njoined: uniform — test member"],
			["team-message", "[team #3] uniform → you (direct):\nfor main"],
			["team-message", "[team #4] you → #team: main's plan\nmain's plan"],
		]);
		assert.equal(back.length, 6);
		assert.match(back[4][1], /^\[settled\] subagent tango[\s\S]*tango done$/);
		assert.match(back[5][1], /^\[settled\] subagent uniform[\s\S]*team: Sent #3 to main\.$/);
		await sleep(1000);
		assert.ok(!tree.events.slice(mark).some((e) => e.type === "agent_start"), "the redelivery started a turn");
		// tango's result went out in a tool result on the other branch; on this one it went out as a message.
		assert.match((await tree.call({ action: "status", id: "tango" })).text, /Its result was sent to you as a subagent-result message\./);
		await treeTo(tree, treeEnd);
		assert.deepEqual(after((await branchOf(tree)).branch, treeEnd), []);
	} finally {
		await tree.close();
	}
});

await step("a branch that holds a later team message still gets an earlier one it lacks, and only that one", async () => {
	const early = nextSeq(logOf(treeSession));
	fs.appendFileSync(logOf(treeSession), missed(early, "gap early", "uniform") + missed(early + 1, "gap late", "uniform"));
	// Without the team extension, only the later message joins the branch, as a message for main does.
	const plain = startParent(["--session", treeSession, "--no-extensions", "-e", busyExtension]);
	current = plain;
	let leaf;
	try {
		const from = plain.events.length;
		const late = { team: teamIdOf(logOf(treeSession)), seq: early + 1, from: "uniform" };
		plain.prompt(`/deliver ${JSON.stringify({ customType: "team-message", content: `[team #${early + 1}] uniform → you (direct):\ngap late\n\n`, display: true, details: late })}`);
		await plain.waitEvent((e) => e.type === "extension_ui_request" && e.message === "delivered", from);
		const { branch, leafId } = await branchOf(plain);
		assert.ok(delivered(branch).includes(early + 1) && !delivered(branch).includes(early), "no gap");
		leaf = leafId;
	} finally {
		await plain.close();
	}
	const reopened = startParent(["--session", treeSession, ...treeArgs]);
	current = reopened;
	try {
		assert.deepEqual(after((await branchOf(reopened)).branch, leaf), [["team-message", `[team #${early}] uniform → you (direct):\ngap early`]]);
	} finally {
		await reopened.close();
	}
});

await step("after a move to a team message with a summary, that message arrives in full and one notice line counts those the summary covers", async () => {
	const tree = startParent(["--session", treeSession, ...treeArgs]);
	current = tree;
	try {
		const from = tree.events.length;
		const sent = await tree.call({ action: "send", to: "uniform", body: TEAM({ action: "send", to: "main", body: "summarized" }) }, "team");
		const dm = Number(sent.text.match(/^Sent #(\d+) to uniform \(woken\)\.$/)[1]) + 1;
		await resultArrives(tree, from);
		assert.match((await tree.call({ action: "send", title: "after the message", body: "after the message" }, "team")).text, new RegExp(`^Posted #${dm + 1}\\.`));
		// Pi summarizes the entries after the selected message and moves to its parent, so neither holds the message itself.
		const target = (await branchOf(tree)).branch.find((e) => e.customType === "team-message" && e.details.seq === dm);
		await treeTo(tree, target.id, 0);
		const { branch } = await branchOf(tree);
		const back = after(branch, target.parentId);
		assert.deepEqual(back.slice(0, 3), [
			["branch_summary", ""],
			["team-notice", `[team] The branch summary covers 1 team message to or from you (#${dm + 1}); read them with team history (with: a member, for direct messages; thread: a #seq, for a thread).`],
			["team-message", `[team #${dm}] uniform → you (direct):\nsummarized`],
		]);
		assert.deepEqual(branch.at(-3).details.covered, [dm + 1]);
		assert.equal(back.length, 4);
		assert.match(back[3][1], new RegExp(`^\\[settled\\] subagent uniform[\\s\\S]*team: Sent #${dm} to main\\.$`));
	} finally {
		await tree.close();
	}
});

await step("a team message that reaches the main agent while it summarizes a branch arrives once", async () => {
	const tree = startParent(["--session", treeSession, ...treeArgs]);
	current = tree;
	try {
		await tree.call({ action: "run", name: "victor", message: `SLOW 1500 ${TEAM({ action: "send", to: "main", body: "during navigation" })}`, waitMs: 0 });
		const from = tree.events.length;
		const moved = await treeTo(tree, treeStart, 8000);
		const queued = tree.events.findIndex((e, i) => i >= from && e.type === "extension_ui_request" && e.message === "subagent victor: team message waiting for the main agent");
		assert.ok(queued !== -1 && queued < tree.events.indexOf(moved), "the message came after the navigation");
		const message = await tree.waitMessage("team-message", tree.events.indexOf(moved));
		assert.match(message.content, /\nduring navigation$/);
		await resultArrives(tree, from);
		const { branch } = await branchOf(tree);
		assert.equal(delivered(branch).filter((seq) => seq === message.details.seq).length, 1);
	} finally {
		await tree.close();
	}
});

await step("of many team messages a branch lacks, the latest ten arrive in full and one notice line counts the others", async () => {
	const first = nextSeq(logOf(treeSession));
	for (let i = 0; i < 12; i++) fs.appendFileSync(logOf(treeSession), missed(first + i, `missed ${i}`, "uniform"));
	// The second reopen finds them all seen.
	let leaf = "";
	for (const expected of [
		[
			["team-notice", `[team] Not shown here: 2 team messages to or from you (#${first} to #${first + 1}), earlier than those below; read them with team history (with: a member, for direct messages; thread: a #seq, for a thread).`],
			...Array.from({ length: 10 }, (_, i) => ["team-message", `[team #${first + 2 + i}] uniform → you (direct):\nmissed ${2 + i}`]),
		],
		[],
	]) {
		const opened = startParent(["--session", treeSession, ...treeArgs]);
		current = opened;
		try {
			const { branch, leafId } = await branchOf(opened);
			leaf ||= branch.findLast((e) => e.message?.role === "assistant").id;
			assert.deepEqual(after(branch, leaf), expected);
			if (expected.length) assert.deepEqual(branch.at(-11).details.covered, [first, first + 1]);
			leaf = leafId;
		} finally {
			await opened.close();
		}
	}
});

await step("a result arriving while a prompt's run is starting and its board digest each arrive once", async () => {
	const pre = startParent(["--session-dir", treeSessions, ...treeArgs]);
	current = pre;
	try {
		await pre.call({ action: "run", name: "whiskey", message: TEAMS([{ action: "send", title: "whiskey news", body: "whiskey news" }, { action: "wait", ms: 2000 }]), waitMs: 0 });
		// The post is on the board once whiskey asks the model again.
		await until(() => requestsBy("whiskey").length >= 2);
		const from = pre.events.length;
		pre.prompt("SAY preflight");
		await resultArrives(pre, from);
		const answered = await pre.waitEvent((e) => e.type === "message_end" && e.message.role === "assistant" && text(e.message) === "preflight", from);
		const settled = await pre.waitEvent((e) => e.type === "agent_settled", pre.events.indexOf(answered));
		assert.equal(settled.aborted, false);
		await sleep(1000);
		const { entries } = (await pre.request({ type: "get_entries" })).data;
		assert.equal(entries.filter((e) => e.customType === "subagent-result" && e.details?.id === "whiskey").length, 1);
		assert.equal(entries.filter((e) => e.customType === "team-notice" && e.content.includes("whiskey news")).length, 1);
	} finally {
		await pre.close();
	}
});

await step("a result or team message in a batch another extension drops at the main agent's turn boundary arrives at its next boundary of the same run, once", async () => {
	const dropper = join(WORK_DIR, "main-drop-extension.ts");
	// Loaded after the subagent extension, it empties the first turn_end batch that holds a subagent result, and the first that holds a team message.
	fs.writeFileSync(
		dropper,
		`export default function (pi) {
	const dropped = new Set();
	pi.on("turn_end", (event, ctx) => {
		const types = event.entries.map((e) => e.customType).filter((type) => (type === "subagent-result" || type === "team-message") && !dropped.has(type));
		if (!types.length) return;
		for (const type of types) dropped.add(type);
		ctx.ui.notify(\`dropped \${types.join(",")}\`, "info");
		return { entries: [] };
	});
}
`,
	);
	// Only this step's model requests: earlier steps hire a member named romeo too.
	const earlier = fs.existsSync(REQUESTS) ? requests().length : 0;
	const p = startParent(["--session-dir", join(WORK_DIR, "drop-sessions"), "--no-extensions", "-e", fileURLToPath(new URL("..", import.meta.url)), "-e", dropper]);
	current = p;
	/** Member `name` runs `script`, whose message of `customType` reaches the main agent during a team wait; the batch holding it is dropped. */
	const dropOnce = async (name, script, customType) => {
		await p.call({ action: "run", name, message: script, waitMs: 0 });
		const from = p.events.length;
		await p.call({ action: "wait", ms: 8000 }, "team");
		const drop = p.events.findIndex((e, i) => i >= from && e.type === "extension_ui_request" && e.message === `dropped ${customType}`);
		assert.ok(drop !== -1, `no batch with a ${customType} was dropped`);
		const arrived = p.events.findIndex((e, i) => i > drop && asMessage(e)?.customType === customType);
		const settled = p.events.findIndex((e, i) => i > drop && e.type === "agent_settled");
		assert.ok(arrived !== -1 && arrived < settled, `the dropped ${customType} did not arrive in the same run`);
	};
	try {
		await dropOnce("romeo", "SLOW 2500 SAY repro", "subagent-result");
		assert.match((await p.call({ action: "status", id: "romeo" })).text, /\n\nIts result was sent to you as a subagent-result message\. Full reply: /);
		const from = p.events.length;
		await dropOnce("tango", `SLOW 2500 ${TEAM({ action: "send", to: "main", body: "dropped note" })}`, "team-message");
		// tango's result may arrive after that run, starting another.
		const result = await p.waitEvent((e) => asMessage(e)?.customType === "subagent-result" && asMessage(e).details?.id === "tango", from);
		await p.waitEvent((e) => e.type === "agent_settled", p.events.indexOf(result));
		const { branch } = await branchOf(p);
		const count = (customType, match) => branch.filter((e) => e.type === "custom_message" && e.customType === customType && match(e)).length;
		assert.equal(count("subagent-result", (e) => e.details.id === "romeo"), 1);
		assert.equal(count("subagent-result", (e) => e.details.id === "tango"), 1);
		assert.equal(count("team-message", (e) => e.details.from === "tango"), 1);
		const seen = requests().slice(earlier);
		assert.ok(seen.some((body) => body.messages.some((m) => m.role === "user" && /^\[settled\] subagent romeo[\s\S]*\nrepro$/.test(text(m)))), "the result did not reach the model");
		assert.ok(seen.some((body) => body.messages.some((m) => isTeam(m) && text(m).endsWith("\ndropped note"))), "the team message did not reach the model");
	} finally {
		await p.close();
	}
});

console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
