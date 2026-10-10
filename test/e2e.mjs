// Drives a parent `pi --mode rpc` that loads the extension, against test/fake-llm.mjs.
// Started by test/local.sh, which provides the environment.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { basename, dirname, join } from "node:path";

const { REQUESTS_LOG: REQUESTS, WORK_DIR, PI_CLI } = process.env;
const [command, ...prefix] = PI_CLI ? [process.execPath, PI_CLI] : ["pi"];
const parent = spawn(command, [...prefix, "--mode", "rpc", "--model", "fake/fake-model", "--session-dir", join(WORK_DIR, "sessions")], {
	cwd: join(WORK_DIR, "project"),
	stdio: "pipe",
});
const commandLines = () =>
	process.platform === "win32"
		? execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object CommandLine"], { encoding: "utf8" })
		: execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
const events = [];
const listeners = new Set();
let buffer = "";
parent.stdout.on("data", (chunk) => {
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
parent.stderr.on("data", (chunk) => (stderr += chunk));

function waitEvent(predicate, from = 0, ms = 60_000) {
	return new Promise((resolve, reject) => {
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
}

async function call(args) {
	const from = events.length;
	// followUp: a delivered subagent result may have started a parent turn.
	parent.stdin.write(`${JSON.stringify({ type: "prompt", message: `CALL ${JSON.stringify(args)}`, streamingBehavior: "followUp" })}\n`);
	const end = await waitEvent((e) => e.type === "tool_execution_end" && e.toolName === "subagent", from);
	await waitEvent((e) => e.type === "agent_settled", events.indexOf(end));
	return { text: end.result.content.map((c) => c.text).join(""), isError: end.isError };
}

const childRequest = (said) =>
	fs
		.readFileSync(REQUESTS, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.find((body) => body.messages?.at(-1)?.role === "user" && JSON.stringify(body.messages.at(-1).content).includes(said));
const rawText = (m) => (typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join(""));
const text = (m) => rawText(m).trimEnd();
const idOf = (text) => text.match(/^\[\w+\] subagent ([0-9a-f]{6})/)?.[1];
const LIVE = /^\[running\] subagent [0-9a-f]{6}(?: · \S+)? · turn \d+ · .+ · last event \d+s ago · \d+s$/m;
// An idle parent gets a message through sendMessage (message_end); a busy one at a turn boundary (entry_appended).
const asMessage = (e) =>
	e.type === "message_end" && e.message?.role === "custom"
		? e.message
		: e.type === "entry_appended" && e.entry?.type === "custom_message"
			? e.entry
			: undefined;
// Messages end with a blank line that separates them; assertions compare the text before it.
const trimmed = (m) => m && { ...m, content: m.content.trimEnd() };
const subagentMessages = (from = 0) =>
	events
		.slice(from)
		.map(asMessage)
		.filter((m) => m?.customType?.startsWith("subagent-"))
		.map(trimmed);
const notifications = (from = 0) => subagentMessages(from).filter((m) => m.customType === "subagent-result");
const waitMessage = (customType, from, ms) => waitEvent((e) => asMessage(e)?.customType === customType, from, ms).then((e) => trimmed(asMessage(e)));

let failed = 0;
async function step(name, fn) {
	if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
	try {
		await fn();
		console.log(`PASS  ${name}`);
	} catch (error) {
		failed++;
		console.log(`FAIL  ${name}\n      ${String(error.stack || error).split("\n").slice(0, 6).join("\n      ")}`);
		const recent = events.slice(-8).map((e) => JSON.stringify(e).slice(0, 300));
		console.log(`      recent events:\n        ${recent.join("\n        ")}`);
	}
}

let first;
await step("run returns the result when the child finishes within waitMs", async () => {
	const r = await call({ action: "run", message: "SAY hello" });
	assert.match(r.text, /^\[settled\] subagent [0-9a-f]{6} · fake\/fake-model · 1 turns/);
	assert.match(r.text, /hello$/);
	assert.doesNotMatch(r.text, /Note:|\(Background:/);
	first = idOf(r.text);
});

await step("children run the default model and get the report tool instead of the subagent tool", async () => {
	const r = await call({ action: "run", message: "TOOLS?" });
	const tools = r.text.match(/^tools: (.*)$/m)?.[1].split(",");
	assert.ok(tools?.includes("read"), r.text);
	assert.ok(tools.includes("report_to_main_agent"), r.text);
	assert.ok(!tools.includes("subagent"), r.text);
	assert.equal(childRequest("TOOLS?").model, "fake-model");
});

await step("fork gives the child this conversation; fresh does not", async () => {
	const r = await call({ action: "run", context: "fork", message: "SAY forked" });
	assert.match(r.text, /^\[settled\].*\n\nforked$/s);
	// The forked child is told what it is, ahead of its task.
	const forked = childRequest("You are a subagent").messages;
	assert.match(JSON.stringify(forked.at(-1).content), /Task:\\nSAY forked/);
	assert.ok(forked.some((m) => m.tool_calls?.some((c) => c.function.name === "subagent")), "fork lacks the parent's tool calls");
	assert.ok(!childRequest("SAY hello").messages.some((m) => m.tool_calls), "fresh child saw parent history");
});

await step("status without id lists subagents", async () => {
	const r = await call({ action: "status" });
	assert.match(r.text, new RegExp(`\\[settled\\] subagent ${first}`));
});

await step("follow_up restarts a finished child in its own session", async () => {
	const r = await call({ action: "follow_up", id: first, message: "SAY again" });
	assert.match(r.text, /^\[settled\].*again$/s);
	assert.ok(childRequest("SAY again").messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("SAY hello")), "session history missing");
});

await step("a result that outlives waitMs arrives once as a message that starts a turn", async () => {
	const r = await call({ action: "run", message: "SLOW 2000 SAY late", waitMs: 300 });
	assert.match(r.text, LIVE);
	const id = idOf(r.text);
	const from = events.length;
	const note = await waitMessage("subagent-result", from);
	assert.match(note.content, new RegExp(`^\\[settled\\] subagent ${id}.*late$`, "s"));
	await waitEvent((e) => e.type === "agent_settled", from);
	assert.equal(notifications(from).length, 1);
	assert.ok(childRequest("[settled]"), "notification did not reach the model");
	// Asking afterwards does not repeat the result.
	const again = await call({ action: "status", id });
	assert.match(again.text, /^\[settled\].*sent to you as a subagent-result message\.$/s);
	assert.doesNotMatch(again.text, /late/);
});

const send = (record) => parent.stdin.write(`${JSON.stringify(record)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const finalFile = (id) =>
	fs.readdirSync(join(WORK_DIR, "sessions"), { recursive: true }).some((p) => String(p).replaceAll("\\", "/").endsWith(`subagents/${id}/final.md`));
async function until(predicate, ms = 60_000) {
	for (const end = Date.now() + ms; !predicate(); await sleep(100)) if (Date.now() > end) throw new Error("timed out");
}

await step("results that reach a busy parent arrive together right after its current tool calls", async () => {
	const from = events.length;
	const ids = [];
	for (const n of [1, 2]) ids.push(idOf((await call({ action: "run", message: `SLOW 4000 SAY busy${n}`, waitMs: 0 })).text));
	const mark = events.length;
	send({ type: "prompt", streamingBehavior: "followUp", message: `CALLS 15000 ${JSON.stringify({ action: "run", message: "SLOW 1000 SAY busy3", waitMs: 0 })} || ${JSON.stringify({ action: "status" })}` });
	const started = await waitEvent((e) => e.type === "tool_execution_end" && e.toolName === "subagent", mark);
	ids.push(idOf(started.result.content[0].text));
	await waitEvent((e) => e.type === "agent_settled", events.indexOf(started));
	assert.equal(notifications(from).length, 3);
	// All three in the first model request that has any of them, right after the status tool result.
	const result = (n) => (m) => m.role === "user" && /^\[settled\] subagent [\s\S]*\n\nbusy\d$/.test(text(m)) && text(m).endsWith(`busy${n}`);
	const seen = fs
		.readFileSync(REQUESTS, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line).messages ?? [])
		.find((messages) => [1, 2, 3].some((n) => messages.some(result(n))));
	assert.equal(seen.at(-4).role, "tool");
	// Each ends with a blank line, so the joined messages stay apart.
	for (const m of seen.slice(-3)) assert.ok(rawText(m).endsWith("\n\n"), JSON.stringify(rawText(m)));
	for (const n of [1, 2, 3]) assert.ok(seen.slice(-3).some(result(n)), `busy${n} is not in the same request`);
});

await step("a tool wait ends early when another subagent sends a message", async () => {
	const hung = idOf((await call({ action: "run", message: "HANG", waitMs: 0 })).text);
	const from = events.length;
	await call({ action: "run", message: "SLOW 2000 REPORT ping", waitMs: 0 });
	const started = Date.now();
	const s = await call({ action: "status", id: hung, waitMs: 60_000 });
	assert.ok(Date.now() - started < 30_000, "the wait was not cut short");
	assert.match(s.text, /Returned early: subagent messages follow this result\./);
	assert.ok(subagentMessages(from).some((m) => m.customType === "subagent-report" && /: ping$/.test(m.content)));
	await call({ action: "abort", id: hung });
});

await step("a result queued in a turn stopped with Esc is kept without waking the parent", async () => {
	const from = events.length;
	send({ type: "prompt", streamingBehavior: "followUp", message: `CALL ${JSON.stringify({ action: "run", message: "SAY esc", waitMs: 0 })} HOLD` });
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

await step("a result returned by a call is not delivered again", async () => {
	const from = events.length;
	const r = await call({ action: "run", message: "SLOW 300 SAY quick", waitMs: 10_000 });
	assert.match(r.text, /quick$/);
	await new Promise((done) => setTimeout(done, 1500));
	assert.equal(notifications(from).length, 0);
});

await step("steer redirects a running child", async () => {
	const r = await call({ action: "run", message: "SLOW 8000 SAY first", waitMs: 200 });
	const id = idOf(r.text);
	const s = await call({ action: "steer", id, message: "SAY steered" });
	assert.equal(s.text, "steer queued");
	const done = await call({ action: "status", id, waitMs: 20_000 });
	assert.match(done.text, /^\[settled\].*steered$/s);
});

await step("follow_up on a running child returns within waitMs and runs after the current request", async () => {
	const r = await call({ action: "run", message: "SLOW 3000 SAY one", waitMs: 0 });
	const id = idOf(r.text);
	const started = Date.now();
	const f = await call({ action: "follow_up", id, message: "SAY two", waitMs: 0 });
	assert.match(f.text, LIVE);
	assert.ok(Date.now() - started < 2500, "follow_up waited past waitMs");
	const done = await call({ action: "status", id, waitMs: 30_000 });
	assert.match(done.text, /^\[settled\].*two$/s);
});

await step("abort stops a hung child; other results show it in their footer", async () => {
	const r = await call({ action: "run", message: "HANG", waitMs: 500 });
	assert.match(r.text, LIVE);
	const id = idOf(r.text);
	const other = await call({ action: "run", message: "SAY side" });
	assert.match(other.text, new RegExp(`side\\n\\n\\(Background: ${id} running \\d+s\\.\\)$`));
	const a = await call({ action: "abort", id });
	assert.match(a.text, /^\[aborted\]/);
	assert.doesNotMatch(a.text, /Background/);
});

await step("a subagent's report reaches the parent while it works", async () => {
	const from = events.length;
	const r = await call({ action: "run", message: "REPORT root cause found", waitMs: 30_000 });
	const id = idOf(r.text);
	// The report ends the wait; the final result follows it as a message.
	assert.doesNotMatch(r.text, /reported$/);
	await waitMessage("subagent-result", from);
	const messages = subagentMessages(from);
	assert.deepEqual(
		messages.map((m) => m.customType),
		["subagent-report", "subagent-result"],
	);
	assert.equal(messages[0].content, `[report] subagent ${id}: root cause found`);
	assert.match(messages[1].content, /reported$/);
	await waitEvent((e) => e.type === "agent_settled", events.length - 1);
});

await step("run warns when args remove the report tool", async () => {
	const toolsOf = (text) => text.match(/^tools: (.*)$/m)?.[1].split(",");
	const cut = await call({ action: "run", message: "TOOLS?", args: ["--tools", "report_to_main_agent", "--tools", "read"] });
	assert.match(cut.text, /Note: these args remove report_to_main_agent/);
	assert.deepEqual(toolsOf(cut.text), ["read"]);
	const kept = await call({ action: "run", message: "TOOLS?", args: ["--no-tools", "--tools", "read,report_*"] });
	assert.doesNotMatch(kept.text, /Note:/);
	assert.ok(toolsOf(kept.text)?.includes("report_to_main_agent"), kept.text);
});

await step("a child that cannot start reports an error with Pi's output", async () => {
	const r = await call({ action: "run", message: "SAY x", args: ["-z"], waitMs: 30_000 });
	assert.match(r.text, /^\[error\] subagent [0-9a-f]{6} · 0 turns/);
	assert.match(r.text, /Pi exited \(code [1-9]/);
	assert.match(r.text, /-z/);
});

await step("owned flags and unknown ids are rejected", async () => {
	const bad = await call({ action: "run", message: "SAY x", args: ["--session-dir=/tmp/x"] });
	assert.ok(bad.isError);
	assert.match(bad.text, /must not include --session-dir=/);
	const unknown = await call({ action: "steer", id: "zzzzzz", message: "x" });
	assert.ok(unknown.isError);
	assert.match(unknown.text, /Unknown subagent id/);
});

await step("children end with the parent session", async () => {
	await call({ action: "run", message: "HANG", waitMs: 300 });
	parent.stdin.end();
	await new Promise((done) => parent.on("exit", done));
	await new Promise((done) => setTimeout(done, 5000));
	const left = commandLines()
		.split(/\r?\n/)
		.filter((l) => l.includes("--mode rpc") && l.includes(basename(dirname(WORK_DIR))));
	assert.deepEqual(left, []);
});

if (parent.exitCode === null) parent.kill();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
