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
const idOf = (text) => text.match(/^\[\w+\] subagent ([0-9a-f]{6})/)?.[1];
const LIVE = /^\[running\] subagent [0-9a-f]{6}(?: · \S+)? · turn \d+ · .+ · last event \d+s ago · \d+s$/m;
const notifications = (from = 0) => events.slice(from).filter((e) => e.type === "message_end" && e.message?.customType === "subagent-result");

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
	assert.match(r.text, /hello/);
	first = idOf(r.text);
});

await step("children run the default model and do not get the subagent tool", async () => {
	const r = await call({ action: "run", message: "TOOLS?" });
	const tools = r.text.match(/^tools: (.*)$/m)?.[1].split(",");
	assert.ok(tools?.includes("read"), r.text);
	assert.ok(!tools.includes("subagent"), r.text);
	assert.equal(childRequest("TOOLS?").model, "fake-model");
});

await step("fork gives the child this conversation; fresh does not", async () => {
	const r = await call({ action: "run", context: "fork", message: "SAY forked" });
	assert.match(r.text, /^\[settled\].*\n\nforked$/s);
	const forked = childRequest("SAY forked").messages;
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
	const note = await waitEvent((e) => e.type === "message_end" && e.message?.customType === "subagent-result", from);
	assert.match(note.message.content, new RegExp(`^\\[settled\\] subagent ${id}.*late$`, "s"));
	await waitEvent((e) => e.type === "agent_settled", from);
	assert.equal(notifications(from).length, 1);
	assert.ok(childRequest("[settled]"), "notification did not reach the model");
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

await step("abort stops a hung child", async () => {
	const r = await call({ action: "run", message: "HANG", waitMs: 500 });
	assert.match(r.text, LIVE);
	const a = await call({ action: "abort", id: idOf(r.text) });
	assert.match(a.text, /^\[aborted\]/);
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
