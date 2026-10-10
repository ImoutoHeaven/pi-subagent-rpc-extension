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
const LIVE = /^\[running\] subagent [0-9a-z-]+(?: · \S+)? · turn \d+ · .+ · last event \d+s ago · \d+s$/m;
// An idle parent gets a message through sendMessage (message_end); a busy one at a turn boundary (entry_appended).
const asMessage = (e) =>
	e.type === "message_end" && e.message?.role === "custom"
		? e.message
		: e.type === "entry_appended" && e.entry?.type === "custom_message"
			? e.entry
			: undefined;
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
	/** A model-issued call of the subagent or team tool. */
	const call = async (args, tool = "subagent") => {
		const from = events.length;
		prompt(`${tool === "team" ? "TEAM" : "CALL"} ${JSON.stringify(args)}`);
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
			.filter((m) => m?.customType?.startsWith("subagent-") || m?.customType === "team-message")
			.map(trimmed);
	const waitMessage = (customType, from, ms) => waitEvent((e) => asMessage(e)?.customType === customType, from, ms).then((e) => trimmed(asMessage(e)));
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
	assert.match(r.text, /^\[settled\] subagent first · fake\/fake-model · 1 turns/);
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

await step("follow_up restarts a finished child in its own session", async () => {
	const r = await call({ action: "follow_up", id: first, message: "SAY again" });
	assert.match(r.text, /^\[settled\].*again$/s);
	assert.ok(requestFor("SAY again").messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("SAY hello")), "session history missing");
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

const finalFile = (id) =>
	fs.readdirSync(join(WORK_DIR, "sessions"), { recursive: true }).some((p) => String(p).replaceAll("\\", "/").endsWith(`subagents/${id}/final.md`));

await step("results that reach a busy parent arrive together right after its current tool calls", async () => {
	const from = events.length;
	const ids = [];
	for (const n of [1, 2]) ids.push(idOf((await call({ action: "run", name: `busy${n}`, message: `SLOW 4000 SAY busy${n}`, waitMs: 0 })).text));
	const mark = events.length;
	send({ type: "prompt", streamingBehavior: "followUp", message: `CALLS 15000 ${JSON.stringify({ action: "run", name: "busy3", message: "SLOW 1000 SAY busy3", waitMs: 0 })} || ${JSON.stringify({ action: "status" })}` });
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
	await call({ action: "abort", id: hung });
});

await step("a result queued in a turn stopped with Esc is kept without waking the parent", async () => {
	const from = events.length;
	send({ type: "prompt", streamingBehavior: "followUp", message: `CALL ${JSON.stringify({ action: "run", name: "esc", message: "SAY esc", waitMs: 0 })} HOLD` });
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
	send({ type: "prompt", streamingBehavior: "followUp", message: `CALL ${JSON.stringify({ action: "run", name: "after-esc", message: "SLOW 3000 SAY after esc", waitMs: 0 })} HOLD` });
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

await step("a result returned by a call is not delivered again", async () => {
	const from = events.length;
	const r = await call({ action: "run", name: "quick", message: "SLOW 300 SAY quick", waitMs: 10_000 });
	assert.match(r.text, /quick$/);
	await sleep(1500);
	assert.equal(notifications(from).length, 0);
});

await step("steer redirects a running child", async () => {
	const r = await call({ action: "run", name: "steered", message: "SLOW 8000 SAY first", waitMs: 200 });
	const id = idOf(r.text);
	const s = await call({ action: "steer", id, message: "SAY steered" });
	assert.equal(s.text, "steer queued");
	const done = await call({ action: "status", id, waitMs: 20_000 });
	assert.match(done.text, /^\[settled\].*steered$/s);
});

await step("follow_up on a running child returns within waitMs and runs after the current request", async () => {
	const r = await call({ action: "run", name: "queued", message: "SLOW 3000 SAY one", waitMs: 0 });
	const id = idOf(r.text);
	const started = Date.now();
	const f = await call({ action: "follow_up", id, message: "SAY two", waitMs: 0 });
	assert.match(f.text, LIVE);
	assert.ok(Date.now() - started < 2500, "follow_up waited past waitMs");
	const done = await call({ action: "status", id, waitMs: 30_000 });
	assert.match(done.text, /^\[settled\].*two$/s);
});

await step("abort stops a hung child; other results show it in their footer", async () => {
	const r = await call({ action: "run", name: "hanging", message: "HANG", waitMs: 500 });
	assert.match(r.text, LIVE);
	const id = idOf(r.text);
	const other = await call({ action: "run", name: "side", message: "SAY side" });
	assert.match(other.text, new RegExp(`side\\n\\n\\(Background: ${id} running \\d+s\\.\\)$`));
	const a = await call({ action: "abort", id });
	assert.match(a.text, /^\[aborted\]/);
	assert.doesNotMatch(a.text, /Background/);
});

await step("a child stays a subagent when its extensions reload", async () => {
	const reloader = join(WORK_DIR, "reload-extension.ts");
	fs.writeFileSync(reloader, 'export default function (pi) { pi.registerCommand("reload-now", { handler: (_args, ctx) => ctx.reload() }); }\n');
	const id = idOf((await call({ action: "run", name: "reloaded", message: "SLOW 6000 SAY before reload", args: ["-e", reloader], waitMs: 0 })).text);
	// Extension commands run at once, even while the child is busy; TOOLS? then runs in the same process.
	await call({ action: "follow_up", id, message: "/reload-now", waitMs: 2000 });
	const r = await call({ action: "follow_up", id, message: "TOOLS?", waitMs: 30_000 });
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
	const unknown = await call({ action: "steer", id: "zzzzzz", message: "x" });
	assert.ok(unknown.isError);
	assert.match(unknown.text, /Unknown subagent id/);
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

const team = startParent(["--session-dir", join(WORK_DIR, "team-sessions")]);
current = team;
const run = (args) => team.call({ action: "run", ...args });
const teamCall = (args) => team.call(args, "team");
const TEAM = (args) => `TEAM ${JSON.stringify(args)}`;

await step("run requires a valid name and args that keep the team tool", async () => {
	for (const [args, error] of [
		[{ message: "SAY x" }, /requires name/],
		[{ name: "toolless", args: ["--tools", "read"], message: "SAY x" }, /remove the team tool/],
		[{ name: "main", message: "SAY x" }, /reserved/],
		[{ name: "Bad_Name", message: "SAY x" }, /name must match/],
	]) {
		const r = await run(args);
		assert.ok(r.isError, r.text);
		assert.match(r.text, error);
	}
});

await step("a mention reaches a running member's next request; a stopped member gets it when resumed", async () => {
	const beta = await run({ name: "beta", message: "SAY beta here" });
	assert.match(beta.text, /^\[settled\] subagent beta · fake\/fake-model · 1 turns/);
	const children = requestsBy("beta").length;
	const typo = await teamCall({ action: "send", body: "x", mentions: ["all", "typo"] });
	assert.ok(typo.isError);
	assert.match(typo.text, /Unknown member: typo/);
	const alpha = await run({ name: "alpha", message: `SLOW 3000 ${TEAM({ action: "members" })}`, waitMs: 0 });
	assert.match(alpha.text, LIVE);
	await until(() => requestsBy("alpha").length > 0);
	const sent = await teamCall({ action: "send", body: "hello both", mentions: ["alpha", "beta"] });
	assert.match(sent.text, /^Sent #\d+ to alpha \(running\), beta \(stopped\)\. A stopped member sees it when you resume it with subagent follow_up\.$/);
	const done = await team.call({ action: "status", id: "alpha", waitMs: 30_000 });
	assert.match(done.text, /^\[settled\] subagent alpha.*team: Members:\n- main: main agent\n- beta: stopped\n- alpha: running/s);
	const next = requestsBy("alpha").at(-1).messages;
	assert.equal(next.at(-2).role, "tool");
	assert.match(text(next.at(-1)), /^\[team #\d+\] main → #team, mentions you, beta:\nhello both$/);
	await sleep(1000);
	assert.equal(requestsBy("beta").length, children, "a team message started a stopped member");
	const resumed = await team.call({ action: "follow_up", id: "beta", message: "SAY beta again" });
	assert.match(resumed.text, /beta again$/);
	const start = requestsBy("beta").at(-1).messages.at(-1);
	assert.match(text(start), /^\[team\] You are beta,[\s\S]*\[team #\d+\] main → #team, mentions alpha, you:\nhello both$/);
});

await step("a direct message between two members is invisible to a third", async () => {
	const dm = await team.call({ action: "follow_up", id: "alpha", message: TEAM({ action: "send", to: "beta", body: "secret plan" }) });
	assert.match(dm.text, /team: Sent #\d+ to beta \(stopped\)\. A stopped member sees it when the main agent resumes it; ask the main agent if it needs to act\.$/);
	const board = await run({ name: "gamma", message: TEAM({ action: "history" }) });
	assert.match(board.text, /hello both/);
	assert.doesNotMatch(board.text, /secret plan/);
	const direct = await team.call({ action: "follow_up", id: "gamma", message: TEAM({ action: "history", with: "alpha" }) });
	assert.match(direct.text, /team: No messages\.$/);
	const own = await team.call({ action: "follow_up", id: "beta", message: TEAM({ action: "history", with: "alpha", query: "SECRET" }) });
	assert.match(own.text, /\[team #\d+\] alpha → you \(direct\):\nsecret plan$/);
	const main = await teamCall({ action: "history", with: "alpha" });
	assert.equal(main.text, "No messages.");
});

await step("wait returns early when a message arrives, and the message follows the tool result", async () => {
	await run({ name: "delta", message: TEAM({ action: "wait", ms: 60_000 }), waitMs: 0 });
	await until(() => requestsBy("delta").length > 0);
	await sleep(1000);
	const started = Date.now();
	await teamCall({ action: "send", to: "delta", body: "wake up" });
	const done = await team.call({ action: "status", id: "delta", waitMs: 30_000 });
	assert.ok(Date.now() - started < 20_000, "the wait was not cut short");
	assert.match(done.text, /team: 1 team message\(s\) for you follow this result\.$/);
	const next = requestsBy("delta").at(-1).messages;
	assert.equal(next.at(-2).role, "tool");
	assert.match(text(next.at(-1)), /^\[team #\d+\] main → you \(direct\):\nwake up$/);
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

await step("a team member without the extension fails its run", async () => {
	const empty = join(WORK_DIR, "empty-extension.ts");
	fs.writeFileSync(empty, "export default function () {}\n");
	const r = await run({ name: "bare", message: "SAY x", args: ["--no-extensions", "-e", empty] });
	assert.match(r.text, /^\[error\] subagent bare/);
	assert.match(r.text, /team extension did not load/);
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
const missed = (seq, body) => `${JSON.stringify({ t: "msg", seq, at: Date.now(), from: "alpha", to: "main", notify: ["main"], body })}\n`;
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
		assert.ok(!requests().slice(before).some((body) => body.messages.some((m) => rawText(m).startsWith("[team] You are"))), "a member started");
	} finally {
		await resumed.close();
	}
});

await step("a torn last line in the team log does not swallow the next record", async () => {
	const seq = nextSeq(logOf(teamSession));
	fs.appendFileSync(logOf(teamSession), '{"t":"msg","seq":');
	for (const check of [
		async (parent) => assert.match((await parent.call({ action: "send", body: "after the tear" }, "team")).text, new RegExp(`^Posted #${seq}\\.`)),
		async (parent) => assert.equal((await parent.call({ action: "history", query: "after the tear" }, "team")).text, `[team #${seq}] you → #team:\nafter the tear`),
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
		assert.ok((await teamMessages(original)).some((e) => e.details.seq >= 1), "the original team delivered nothing to inherit");
		assert.equal((await original.request({ type: "clone" })).data.cancelled, false);
		clone = (await original.request({ type: "get_state" })).data;
		assert.notEqual(clone.sessionFile, teamSession);
		// alpha belongs to the original team, so hiring it again proves the clone has a team of its own.
		assert.match((await original.call({ action: "run", name: "alpha", message: "SAY cloned" })).text, /^\[settled\] subagent alpha/);
	} finally {
		await original.close();
	}
	fs.appendFileSync(logOf(clone.sessionFile), missed(1, "first in the clone"));
	const reopened = startParent(["--session", clone.sessionFile]);
	current = reopened;
	try {
		const restored = (await teamMessages(reopened)).filter((e) => e.details.team === clone.sessionId);
		assert.deepEqual(
			restored.map((e) => [e.details.seq, e.content.trimEnd()]),
			[[1, "[team #1] alpha → you (direct):\nfirst in the clone"]],
		);
	} finally {
		await reopened.close();
	}
});

console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
