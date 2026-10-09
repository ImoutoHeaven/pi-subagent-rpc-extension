/**
 * Pi subagents as `pi --mode rpc` child processes bound to the parent session.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CHILD_ENV = "PI_SUBAGENT_CHILD";
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 240_000;
const ABORT_WAIT_MS = 10_000;
const MAX_RESULT_CHARS = 16_000;
const NARRATION_LINES = 3;
const MAX_AGENTS = 32;
const FOOTER_AGENTS = 3;
const STALE_MS = 60_000;
const REPORT_TOOL = "report_to_main_agent";
const NARRATION_CHARS = 300;
const STDERR_CHARS = 2_000;
// The extension owns the child's process mode, session, and model selection.
const OWNED_FLAGS = ["--mode", "--print", "-p", "--no-session", "--session", "--session-id", "--session-dir", "--continue", "-c", "--resume", "-r", "--fork", "--export", "--model"];
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
// A forked child sees the parent's whole conversation and would otherwise take itself for the parent.
const FORK_NOTE =
	"You are a subagent: a separate Pi process started by the main agent's `subagent` tool, with a copy of the conversation above. You are not the main agent. The `subagent` call that started you has no result in your copy; that is expected. Do only the task below. Your final reply is returned to the main agent.";

type Status = "running" | "settled" | "aborted" | "error";
type Response = { success: boolean; disposition?: string; error?: string };
interface Command {
	id: string;
	type: "prompt" | "clear_queue" | "abort";
	message?: string;
	streamingBehavior?: "steer" | "followUp";
}

/** One live `pi --mode rpc` process; a follow-up after it exits starts a new one on the same session. */
interface Proc {
	child: ChildProcessWithoutNullStreams;
	queue: Command[];
	replies: Map<string, (response: Response) => void>;
	busy: boolean;
	gate: string | null;
	probe: string | null;
	lastStop: string | null;
	lastError: string | null;
	abortAcked: boolean;
	/** The parent asked to stop; survives the child's own event resets. */
	aborting: boolean;
	finished: boolean;
	stderr: string;
	exited: Promise<void>;
}

interface Agent {
	id: string;
	cwd: string;
	dir: string;
	launchArgs: string[];
	status: Status;
	startedAt: number;
	endedAt: number;
	lastEventAt: number;
	turns: number;
	phase: string;
	/** Running tools; `report` holds the message of a report_to_main_agent call. */
	tools: Map<string, { name: string; since: number; report?: string }>;
	narration: string[];
	/** Rejected steer and follow_up requests, which may arrive after the tool call returned. */
	notes: string[];
	lastText: string;
	/** provider/id the child actually answered with; Pi matches --model fuzzily. */
	model: string;
	error: string | null;
	/** The final result reached the parent: as a tool result, or as a sent message. */
	delivered: boolean;
	/** The final result went out as a message, so tool results show only its header. */
	notified: boolean;
	waiters: Set<() => void>;
	proc?: Proc;
}

const oneLine = (text: string, limit: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

const duration = (ms: number) => {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};

const assistantText = (message: { content?: unknown }) =>
	Array.isArray(message.content)
		? message.content
				.filter((part: { type?: string }) => part.type === "text")
				.map((part: { text?: string }) => part.text ?? "")
				.join("")
				.trim()
		: "";

function killTree(child: ChildProcessWithoutNullStreams) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	// shortcut: on POSIX only Pi itself is signalled; its tool processes rely on Pi's own cleanup.
	if (process.platform === "win32" && child.pid) {
		spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
	} else child.kill("SIGKILL");
}

/** The promise's value, or undefined once `ms` pass or `signal` aborts. */
function within<T>(promise: Promise<T>, ms: number, signal?: AbortSignal) {
	return new Promise<T | undefined>((done) => {
		const settle = (value: T | undefined) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			done(value);
		};
		const cancel = () => settle(undefined);
		const timer = setTimeout(cancel, ms);
		if (signal?.aborted) return cancel();
		signal?.addEventListener("abort", cancel, { once: true });
		void promise.then(settle);
	});
}

/** Whether Pi options `args` keep report_to_main_agent from loading or being active in a child. */
function removesReportTool(args: string[]) {
	const values = (names: string[]) =>
		args.flatMap((arg, i) => (names.includes(arg) ? [(args[i + 1] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)] : []));
	const matches = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(REPORT_TOOL);
	const has = (...names: string[]) => args.some((arg) => names.includes(arg));
	// --no-extensions still loads explicit -e paths, which may include this extension.
	if (has("-ne", "--no-extensions") && !has("-e", "--extension")) return true;
	// The last --exclude-tools and the last --tools win.
	if (values(["-xt", "--exclude-tools"]).at(-1)?.some(matches)) return true;
	const noTools = has("-nt", "--no-tools");
	const tools = values(["-t", "--tools"]).at(-1);
	if (!tools) return noTools;
	if (tools.length && tools.every((entry) => /^[+-]/.test(entry))) {
		// Pi activates extension tools after default-selection edits, so edits only matter over --no-tools,
		// where the last one naming this tool decides.
		if (!noTools) return false;
		const edit = tools.findLast((entry) => entry.slice(1) === REPORT_TOOL);
		return edit ? edit[0] === "-" : true;
	}
	return !tools.some(matches);
}

export default function (pi: ExtensionAPI) {
	if (process.env[CHILD_ENV]) {
		// Inside a subagent: only the upward channel. No subagent tool keeps delegation one level deep.
		pi.registerTool({
			name: REPORT_TOOL,
			label: "Report to main agent",
			description:
				"Send a short message to the main agent that started you, while you keep working. Use it only when the main agent needs to know something before you finish: a finding that changes its plans, a decision you made on its behalf, or a blocker. Do not use it for routine progress or as a log; your final reply already goes to the main agent. Keep it brief and precise.",
			parameters: Type.Object({ message: Type.String({ description: "What the main agent needs to know." }) }),
			async execute() {
				return { content: [{ type: "text" as const, text: "sent" }], details: undefined };
			},
		});
		return;
	}

	const agents = new Map<string, Agent>();
	let shuttingDown = false;
	let parent: ExtensionContext | undefined;
	/** Messages queued into a running parent turn, by nonce, until they are seen in its session. */
	const queued = new Map<string, { customType: string; agentId: string; content: string; details: object }>();

	const isLive = (agent: Agent) => Boolean(agent.proc && !agent.proc.finished);

	const header = (agent: Agent) => {
		const now = Date.now();
		const id = `subagent ${agent.id}${agent.model ? ` · ${agent.model}` : ""}`;
		if (agent.status !== "running") return `[${agent.status}] ${id} · ${agent.turns} turns · ${duration(agent.endedAt - agent.startedAt)}`;
		const activity = agent.tools.size
			? [...agent.tools.values()].map((tool) => `${tool.name} ${duration(now - tool.since)}`).join(", ")
			: agent.phase;
		return `[running] ${id} · turn ${agent.turns + 1} · ${activity} · last event ${duration(now - agent.lastEventAt)} ago · ${duration(now - agent.startedAt)}`;
	};

	/** The model-facing report. */
	const report = (agent: Agent) => {
		if (agent.status === "running") {
			return [header(agent), ...agent.narration, ...agent.notes, "Still running: wait with status, steer, or abort."].join("\n");
		}
		const text =
			agent.lastText.length > MAX_RESULT_CHARS
				? `${agent.lastText.slice(0, MAX_RESULT_CHARS)}\n…[truncated; full reply: ${join(agent.dir, "final.md")}]`
				: agent.lastText;
		return [header(agent), agent.error, agent.notes.join("\n"), text].filter(Boolean).join("\n\n");
	};

	/** Nonces of this extension's messages already in the parent's session. */
	const seenNonces = (ctx: ExtensionContext) =>
		new Set(
			ctx.sessionManager
				.getBranch()
				.flatMap((entry) => (entry.type === "custom_message" ? [(entry.details as { nonce?: string } | undefined)?.nonce] : [])),
		);

	/**
	 * A tool result showing the final state delivers it; a result already sent as a message is not repeated.
	 * Queued reports reach the parent after the tool result, so the final result then goes out as a message
	 * behind them, keeping it the last word.
	 */
	const consume = (agent: Agent) => {
		if (agent.status === "running") return report(agent);
		const reports = [...queued].filter(([, note]) => note.customType === "subagent-report" && note.agentId === agent.id);
		if (!agent.delivered && reports.length && parent) {
			const seen = seenNonces(parent);
			if (reports.some(([nonce]) => !seen.has(nonce))) deliver(agent);
		}
		if (agent.notified) return `${header(agent)}\n\nIts result was sent to you as a subagent-result message.`;
		agent.delivered = true;
		return report(agent);
	};

	/** Other running subagents, so a result also shows what is still in flight. */
	const footer = (except?: Agent) => {
		const now = Date.now();
		const running = [...agents.values()].filter((agent) => agent !== except && agent.status === "running");
		if (!running.length) return "";
		const shown = running.slice(0, FOOTER_AGENTS).map((agent) => {
			const quiet = now - agent.lastEventAt;
			return `${agent.id} running ${duration(now - agent.startedAt)}${quiet > STALE_MS ? ` · no event ${duration(quiet)}` : ""}`;
		});
		const more = running.length > FOOTER_AGENTS ? `, +${running.length - FOOTER_AGENTS} more` : "";
		return `\n\n(Background: ${shown.join(", ")}${more}.)`;
	};

	// Pi steers a message into a running parent turn, or starts a turn when the parent is idle.
	const notify = (customType: string, agent: Agent, content: string) => {
		if (shuttingDown) return;
		const nonce = randomBytes(4).toString("hex");
		const tagged = { id: agent.id, status: agent.status, nonce };
		if (parent && !parent.isIdle()) queued.set(nonce, { customType, agentId: agent.id, content, details: tagged });
		pi.sendMessage({ customType, content, display: true, details: tagged }, { triggerTurn: true, deliverAs: "steer" });
	};

	const deliver = (agent: Agent) => {
		if (agent.delivered || shuttingDown) return;
		agent.delivered = true;
		agent.notified = true;
		notify("subagent-result", agent, report(agent));
	};

	// Clearing the parent's queue (Esc) drops queued notifications; append the lost ones,
	// waking the parent only if it was not stopped on purpose.
	pi.on("agent_settled", (event, ctx) => {
		if (!queued.size) return;
		const seen = seenNonces(ctx);
		const lost = [...queued].filter(([nonce]) => !seen.has(nonce));
		queued.clear();
		// shortcut: an abort that leaves Pi's queue intact (RPC abort without clear_queue) can show a message twice.
		for (const [, note] of lost) {
			pi.sendMessage({ customType: note.customType, content: note.content, display: true, details: note.details }, { triggerTurn: !event.aborted, deliverAs: "steer" });
		}
	});

	/** Fail commands that will never get a response. */
	const dropPending = (proc: Proc, error: string, all: boolean) => {
		const ids = all ? [...proc.replies.keys()] : proc.queue.map((command) => command.id);
		for (const id of ids) proc.replies.get(id)?.({ success: false, error });
		for (const id of ids) proc.replies.delete(id);
		proc.queue = [];
	};

	const finish = (agent: Agent, proc: Proc, status: Status, error: string | null) => {
		if (proc.finished) return;
		proc.finished = true;
		dropPending(proc, `subagent ${status}`, true);
		Object.assign(agent, { status, error, endedAt: Date.now() });
		agent.tools.clear();
		try {
			writeFileSync(join(agent.dir, "final.md"), agent.lastText);
		} catch {
			// The report still carries the reply.
		}
		proc.child.stdin.end();
		setTimeout(() => killTree(proc.child), 5_000).unref();
		const waiting = agent.waiters.size > 0;
		for (const wake of [...agent.waiters]) wake();
		if (!waiting) deliver(agent);
	};

	const write = (proc: Proc, record: object) => {
		if (proc.child.stdin.writable) proc.child.stdin.write(`${JSON.stringify(record)}\n`);
	};

	// Pi's events can lag its state, so Pi's own isStreaming confirms a run is over.
	const maybeFinish = (proc: Proc) => {
		if (proc.finished || proc.busy || proc.gate || proc.probe || proc.queue.length || proc.replies.size) return;
		proc.probe = `probe-${randomBytes(4).toString("hex")}`;
		write(proc, { id: proc.probe, type: "get_state" });
	};

	// A prompt reaching idle Pi starts a run; later prompts wait until it starts so they queue behind it.
	const pump = (proc: Proc) => {
		while (!proc.finished && proc.queue.length && !proc.gate) {
			const command = proc.queue.shift() as Command;
			write(proc, command);
			if (command.type === "prompt" && !proc.busy) proc.gate = command.id;
		}
		maybeFinish(proc);
	};

	const send = (proc: Proc, command: Omit<Command, "id">, prefix: string = command.type) =>
		new Promise<Response>((done) => {
			const id = `${prefix}-${randomBytes(4).toString("hex")}`;
			proc.replies.set(id, done);
			proc.queue.push({ ...command, id });
			pump(proc);
		});

	const conclude = (agent: Agent, proc: Proc) => {
		if (proc.abortAcked || proc.aborting || proc.lastStop === "aborted") finish(agent, proc, "aborted", null);
		else if (proc.lastStop === "error") finish(agent, proc, "error", proc.lastError ?? "assistant error");
		else finish(agent, proc, "settled", null);
	};

	const handle = (agent: Agent, proc: Proc, event: any) => {
		if (proc.finished) return;
		agent.lastEventAt = Date.now();
		switch (event.type) {
			case "response": {
				if (event.id && event.id === proc.probe) {
					proc.probe = null;
					if (!event.success || typeof event.data?.isStreaming !== "boolean") finish(agent, proc, "error", `state check failed: ${event.error ?? "no isStreaming"}`);
					// While streaming, the coming agent_settled checks again.
					else if (!event.data.isStreaming && !proc.busy && !proc.gate && !proc.queue.length && !proc.replies.size) conclude(agent, proc);
					return;
				}
				const reply = proc.replies.get(event.id);
				if (!reply) return;
				proc.replies.delete(event.id);
				const response: Response = { success: Boolean(event.success), disposition: event.data?.disposition, error: event.error };
				if (event.command === "abort" && response.success) proc.abortAcked = true;
				if (event.id.startsWith("run-") && !response.success) {
					proc.lastStop = "error";
					proc.lastError = response.error ?? "prompt rejected";
				} else if (!response.success) agent.notes.push(`${event.id.replace(/-[0-9a-f]+$/, "")} rejected: ${response.error}`);
				if (response.disposition === "started") proc.gate = event.id;
				else if (event.id === proc.gate) proc.gate = null;
				reply(response);
				pump(proc);
				return;
			}
			case "agent_start":
				Object.assign(proc, { busy: true, gate: null, abortAcked: false, lastStop: null });
				pump(proc);
				return;
			case "turn_start":
				agent.tools.clear();
				agent.phase = "waiting for model";
				return;
			case "message_update": {
				const kind = event.assistantMessageEvent?.type;
				if (kind === "thinking_delta") agent.phase = "thinking";
				else if (kind === "text_delta") agent.phase = "writing";
				else if (kind === "toolcall_start") agent.phase = "preparing tool call";
				return;
			}
			case "tool_execution_start": {
				const message = event.toolName === REPORT_TOOL && typeof event.args?.message === "string" ? event.args.message.trim() : "";
				agent.tools.set(event.toolCallId, { name: event.toolName, since: Date.now(), ...(message ? { report: message } : {}) });
				return;
			}
			case "tool_execution_end": {
				const message = agent.tools.get(event.toolCallId)?.report;
				agent.tools.delete(event.toolCallId);
				if (message && !event.isError) {
					agent.narration = [...agent.narration, `[t${agent.turns + 1}] report: ${oneLine(message, NARRATION_CHARS)}`].slice(-NARRATION_LINES);
					notify("subagent-report", agent, `[report] subagent ${agent.id}: ${message}`);
				}
				agent.phase = "finishing turn";
				return;
			}
			case "message_end": {
				if (event.message?.role !== "assistant") return;
				if (event.message.provider && event.message.model) agent.model = `${event.message.provider}/${event.message.model}`;
				proc.lastStop = event.message.stopReason ?? null;
				if (proc.lastStop === "error") proc.lastError = event.message.errorMessage ?? "assistant error";
				const text = assistantText(event.message);
				if (text) {
					agent.lastText = text;
					agent.narration = [...agent.narration, `[t${agent.turns + 1}] ${oneLine(text, NARRATION_CHARS)}`].slice(-NARRATION_LINES);
				}
				return;
			}
			case "turn_end":
				agent.turns++;
				agent.phase = "between turns";
				return;
			case "agent_settled":
				proc.busy = false;
				proc.gate = null;
				pump(proc);
				return;
			case "auto_retry_start":
				agent.phase = `retrying (${event.attempt}/${event.maxAttempts}): ${oneLine(event.errorMessage ?? "", 120)}`;
				return;
			case "compaction_start":
				agent.phase = "compacting";
				return;
			case "extension_ui_request":
				// No one can answer a child's dialog; cancelling keeps it from blocking forever.
				if (DIALOGS.has(event.method)) write(proc, { type: "extension_ui_response", id: event.id, cancelled: true });
				return;
		}
	};

	const launch = (agent: Agent, message: string) => {
		if (shuttingDown) throw new Error("the session is ending; no new subagent processes start");
		Object.assign(agent, {
			status: "running",
			startedAt: Date.now(),
			lastEventAt: Date.now(),
			turns: 0,
			phase: "starting",
			narration: [],
			notes: [],
			lastText: "",
			model: "",
			error: null,
			delivered: false,
			notified: false,
		});
		agent.tools.clear();
		// The parent's own runtime and CLI entry, so the child runs the same Pi build.
		const command = process.argv[1] ? [process.execPath, process.argv[1]] : ["pi"];
		const child = spawn(command[0], [...command.slice(1), "--mode", "rpc", ...agent.launchArgs], {
			cwd: agent.cwd,
			env: { ...process.env, [CHILD_ENV]: "1" },
			stdio: "pipe",
			windowsHide: true,
		});
		let markExited = () => {};
		const proc: Proc = {
			child,
			queue: [],
			replies: new Map(),
			busy: false,
			gate: null,
			probe: null,
			lastStop: null,
			lastError: null,
			abortAcked: false,
			aborting: false,
			finished: false,
			stderr: "",
			exited: new Promise((done) => (markExited = done)),
		};
		agent.proc = proc;
		child.stdin.on("error", () => {});
		child.stderr.on("data", (chunk) => (proc.stderr = (proc.stderr + chunk).slice(-STDERR_CHARS)));
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		child.stdout.on("data", (chunk) => {
			buffer += decoder.write(chunk);
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					finish(agent, proc, "error", `invalid RPC output: ${oneLine(line, 200)}`);
					killTree(child);
					return;
				}
				handle(agent, proc, event);
			}
		});
		let ended = false;
		const closed = (reason: string, clean = false) => {
			if (ended) return;
			ended = true;
			if (proc.aborting) finish(agent, proc, "aborted", null);
			else if (clean && !proc.busy && !proc.gate && !proc.queue.length) conclude(agent, proc);
			else finish(agent, proc, "error", `${reason}${proc.stderr.trim() ? `\n${proc.stderr.trim()}` : ""}`);
			if (agent.proc === proc) agent.proc = undefined;
			markExited();
		};
		child.on("error", (error) => closed(`could not run Pi: ${error.message}`));
		// "close" fires once stdout drains, so every event is handled first. A descendant that inherited
		// the pipes can hold "close" back indefinitely, so a settled "exit" also ends the process.
		const onEnd = (code: number | null, signal: NodeJS.Signals | null) => closed(`Pi exited (code ${code}, signal ${signal})`, code === 0);
		child.on("close", onEnd);
		child.on("exit", (code, signal) => setTimeout(() => onEnd(code, signal), 2_000).unref());
		void send(proc, { type: "prompt", message }, "run");
	};

	const waitFor = (agent: Agent, ms: number, signal?: AbortSignal) =>
		new Promise<void>((done) => {
			if (agent.status !== "running" || ms <= 0 || signal?.aborted) return done();
			const end = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", end);
				agent.waiters.delete(end);
				done();
			};
			const timer = setTimeout(end, ms);
			signal?.addEventListener("abort", end, { once: true });
			agent.waiters.add(end);
		});

	const stop = async (agent: Agent, signal?: AbortSignal) => {
		const proc = agent.proc;
		if (!proc || proc.finished) return;
		dropPending(proc, "subagent aborted", false);
		write(proc, { id: `clear-${agent.id}`, type: "clear_queue" });
		write(proc, { id: `abort-${agent.id}`, type: "abort" });
		proc.aborting = true;
		await waitFor(agent, ABORT_WAIT_MS, signal);
		if (proc.finished) return;
		// This call returns the final state, so hold a waiter to keep it from also being delivered.
		const hold = () => {};
		agent.waiters.add(hold);
		try {
			killTree(proc.child);
			await proc.exited;
		} finally {
			agent.waiters.delete(hold);
		}
	};

	const create = (params: Params, ctx: ExtensionContext): Agent => {
		if (!params.message) throw new Error("run requires message");
		const cwd = resolve(ctx.cwd, params.cwd ?? ".");
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
		const args = params.args ?? [];
		const owned = args.find((arg) => OWNED_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
		if (owned) throw new Error(`args must not include ${owned}; the extension sets the mode, session, and model (use the model parameter)`);
		const model = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}:${pi.getThinkingLevel()}` : undefined);
		let id: string;
		do id = randomBytes(3).toString("hex");
		while (agents.has(id));
		const parentFile = ctx.sessionManager.getSessionFile();
		const base = parentFile ? parentFile.replace(/\.jsonl$/, "") : join(tmpdir(), "pi-subagent", ctx.sessionManager.getSessionId());
		const dir = join(base, "subagents", id);
		let session = ["--session-dir", dir, "--session-id", id];
		if (params.context === "fork") {
			const leaf = ctx.sessionManager.getLeafId();
			if (!parentFile || !existsSync(parentFile) || !leaf) throw new Error("fork needs a saved parent session; this session has no session file yet");
			mkdirSync(dir, { recursive: true });
			const forked = SessionManager.open(parentFile, dir, cwd).createBranchedSession(leaf);
			if (!forked) throw new Error("fork failed: Pi did not write a session file");
			session = ["--session", forked];
		}
		mkdirSync(dir, { recursive: true });
		const agent: Agent = {
			id,
			cwd,
			dir,
			launchArgs: [...session, ...(model ? ["--model", model] : []), ...args],
			status: "running",
			startedAt: 0,
			endedAt: 0,
			lastEventAt: 0,
			turns: 0,
			phase: "",
			tools: new Map(),
			narration: [],
			notes: [],
			lastText: "",
			model: "",
			error: null,
			delivered: false,
			notified: false,
			waiters: new Set(),
		};
		agents.set(id, agent);
		// Forget the earliest-finished subagents whose processes are gone; running ones stay.
		const done = [...agents.values()].filter((other) => other.status !== "running" && !other.proc).sort((a, b) => a.endedAt - b.endedAt);
		for (const other of done.slice(0, Math.max(0, agents.size - MAX_AGENTS))) agents.delete(other.id);
		return agent;
	};

	const parameters = Type.Object({
		action: StringEnum(["run", "status", "steer", "follow_up", "abort"] as const),
		id: Type.Optional(Type.String({ description: "Subagent id (all actions except run)." })),
		message: Type.Optional(Type.String({ description: "Task for run; text for steer and follow_up." })),
		context: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: "run: fresh (default) starts empty; fork copies this conversation's current branch and tells the subagent it is one." })),
		model: Type.Optional(Type.String({ description: "run: Pi model pattern, provider/id[:thinking]. Default: your current model and thinking level." })),
		cwd: Type.Optional(Type.String({ description: "run: working directory. Default: yours." })),
		args: Type.Optional(Type.Array(Type.String(), { description: "run: extra Pi CLI options, for example tools, extensions, skills, or MCP." })),
		waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, description: `run, status, follow_up: wait up to this long. Default ${DEFAULT_WAIT_MS}.` })),
	});
	type Params = {
		action: "run" | "status" | "steer" | "follow_up" | "abort";
		id?: string;
		message?: string;
		context?: "fresh" | "fork";
		model?: string;
		cwd?: string;
		args?: string[];
		waitMs?: number;
	};

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to a Pi subagent: a separate Pi process with its own session that loads tools, extensions, skills, and MCP servers like a normal Pi launch.",
			"run starts one on message. status reports progress or the result (without id: lists subagents). steer redirects a running subagent after its current tool calls. follow_up sends the next request, restarting a finished subagent in its session. abort stops it.",
			`run, status, and follow_up wait up to waitMs (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}) and return the result if it finishes in time, otherwise its progress while it keeps running. A finished result you have not seen arrives later as a message; do not poll for it. A subagent can also send you short [report] messages while it works; they arrive the same way.`,
			"args are Pi command-line options: read docs/cli.md in the Pi documentation listed in your system prompt, or run `pi --help`. Session, mode, and model flags are set by this tool.",
			"Progress showing no active tool and an old last event suggests a stall: abort, then run again. Subagents cannot delegate further and end with this session.",
		].join("\n\n"),
		parameters,
		async execute(_toolCallId, params: Params, signal, _onUpdate, ctx) {
			parent = ctx;
			const plain = (body: string) => ({ content: [{ type: "text" as const, text: body }], details: undefined });
			const waitMs = Math.min(params.waitMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
			if (params.action === "status" && !params.id) {
				return plain(agents.size ? [...agents.values()].map(header).join("\n") : "No subagents.");
			}
			if (params.action === "run") {
				const agent = create(params, ctx);
				launch(agent, params.context === "fork" ? `${FORK_NOTE}\n\nTask:\n${params.message}` : (params.message as string));
				await waitFor(agent, waitMs, signal);
				const cut = removesReportTool(params.args ?? [])
					? `\n\nNote: these args remove ${REPORT_TOOL}, so this subagent can reach you only through its final reply.`
					: "";
				return plain(consume(agent) + cut + footer(agent));
			}
			const agent = agents.get(params.id ?? "");
			if (!agent) throw new Error(`Unknown subagent id: ${params.id}. Known: ${[...agents.keys()].join(", ") || "none"}`);
			const text = (body: string) => plain(body + footer(agent));
			if (params.action === "status") {
				await waitFor(agent, waitMs, signal);
				return text(consume(agent));
			}
			if (params.action === "abort") {
				await stop(agent, signal);
				return text(consume(agent));
			}
			if (!params.message) throw new Error(`${params.action} requires message`);
			if (params.action === "steer") {
				if (!isLive(agent)) throw new Error(`${agent.id} is not running (${agent.status}); use follow_up`);
				const sent = send(agent.proc as Proc, { type: "prompt", message: params.message, streamingBehavior: "steer" }, "steer");
				const response = await within(sent, DEFAULT_WAIT_MS, signal);
				if (!response) return text(`steer queued until ${agent.id} accepts input`);
				if (!response.success) throw new Error(`steer rejected: ${response.error}`);
				return text(`steer ${response.disposition ?? "sent"}`);
			}
			const deadline = Date.now() + waitMs;
			// Bounded: finish() kills a child that has not exited within seconds.
			// Only await a real exit: a needless yield would let a parallel run prune this subagent before relaunch.
			if (!isLive(agent) && agent.proc) await agent.proc.exited;
			if (isLive(agent)) {
				const sent = send(agent.proc as Proc, { type: "prompt", message: params.message, streamingBehavior: "followUp" }, "follow_up");
				const response = await within(sent, Math.max(0, deadline - Date.now()), signal);
				if (response && !response.success) throw new Error(`follow_up rejected: ${response.error}`);
			} else launch(agent, params.message);
			await waitFor(agent, deadline - Date.now(), signal);
			return text(consume(agent));
		},
	});

	// Waits for the children: Pi exits the process right after shutdown, which would drop pending kill timers.
	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		const procs = [...agents.values()].flatMap((agent) => (agent.proc ? [agent.proc] : []));
		for (const proc of procs) {
			if (!proc.finished) {
				// Abort first: Pi in RPC mode finishes an active run before honouring stdin EOF.
				proc.aborting = true;
				write(proc, { type: "clear_queue" });
				write(proc, { type: "abort" });
			}
			proc.child.stdin.end();
		}
		await Promise.all(
			procs.map(async (proc) => {
				if ((await within(proc.exited.then(() => true), 3_000)) === undefined) {
					killTree(proc.child);
					await within(proc.exited, 2_000);
				}
			}),
		);
	});
}
