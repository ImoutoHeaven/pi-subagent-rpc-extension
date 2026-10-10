/**
 * The parent side: the `subagent` tool, the agent registry, waits, and delivery of results and team messages
 * to the main agent.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { BoundaryState, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BODY_CHARS, DEFAULT_WAIT_MS, MAX_WAIT_MS, type Reply, type Request } from "./protocol.ts";
import { type Run, type RunStatus, startRun } from "./rpc.ts";
import { createTeam, DESCRIPTION_CHARS } from "./team.ts";

const MAX_RESULT_CHARS = 16_000;
const NARRATION_LINES = 3;
const NARRATION_CHARS = 300;
const NOTICES = 3;
const FOOTER_AGENTS = 3;
const STALE_MS = 60_000;
const MAIN = "main";
// The extension owns the child's process mode, session, and model selection.
const OWNED_FLAGS = ["--mode", "--print", "-p", "--no-session", "--session", "--session-id", "--session-dir", "--continue", "-c", "--resume", "-r", "--fork", "--export", "--model"];

/** `stopped`: a member restored from the log that has not run in this session yet. */
type Status = RunStatus | "running" | "stopped";

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
	tools: Map<string, { name: string; since: number }>;
	narration: string[];
	/** The last ctx.ui.notify texts of the run's extensions, such as why a watchdog stopped it. */
	notices: string[];
	lastText: string;
	/** provider/id the child actually answered with; Pi matches --model fuzzily. */
	model: string;
	error: string | null;
	/** Where the final result went, completing "Its result …"; null until it went somewhere. */
	delivered: string | null;
	/** The child sent its start request in this run, so the extension loaded in it. */
	greeted: boolean;
	/** main, or the member whose direct message started this run; a run started by a member cannot wake others. */
	startedBy: string;
	/** Why the final result of a run a member started reached the main agent instead. */
	woken: string;
	// shortcut: the abort lock lives in memory; reopening a session forgets it, and every member is stopped then anyway.
	/** The main agent aborted this member, so only its direct message wakes it. */
	locked: boolean;
	/** Identifies a launch that waits for the previous run's process to exit; null once it started or was cancelled. */
	launching: object | null;
	waiters: Set<() => void>;
	run?: Run;
}

interface Pending {
	customType: string;
	agentId: string;
	content: string;
	details: object;
	/** Information only: it joins the session but never starts a turn. */
	quiet: boolean;
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

/** Whether Pi options `args` keep `tool` from loading or being active in a child. */
function removesTool(args: string[], tool: string) {
	const values = (names: string[]) =>
		args.flatMap((arg, i) => (names.includes(arg) ? [(args[i + 1] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)] : []));
	const matches = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(tool);
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
		const edit = tools.findLast((entry) => entry.slice(1) === tool);
		return edit ? edit[0] === "-" : true;
	}
	return !tools.some(matches);
}

/** The session's file path without .jsonl; subagent sessions and the team log live under it. */
const sessionBase = (ctx: ExtensionContext) => {
	const file = ctx.sessionManager.getSessionFile();
	return file ? file.replace(/\.jsonl$/, "") : join(tmpdir(), "pi-subagent", ctx.sessionManager.getSessionId());
};

export default function setupParent(pi: ExtensionAPI) {
	const agents = new Map<string, Agent>();
	let shuttingDown = false;
	let parent: ExtensionContext | undefined;
	/** The main agent's last run was aborted, as with Esc; deliveries start no turn until a run starts again. */
	let suspended = false;
	/**
	 * Messages for a busy parent, in arrival order. They join its session together at the next turn boundary,
	 * outside Pi's steer queue, which hands over one message per model request and is cleared by Esc.
	 */
	let pending: Pending[] = [];
	/** Ends every tool wait, so a new message does not sit behind a long wait. */
	const waits = new Set<() => void>();
	/** Pending messages that wake the parent. */
	const loud = () => pending.filter((message) => !message.quiet).length;

	const header = (agent: Agent) => {
		const now = Date.now();
		const id = `subagent ${agent.id}${agent.model ? ` · ${agent.model}` : ""}`;
		if (agent.status === "stopped") return `[stopped] ${id}`;
		if (agent.status !== "running") return `[${agent.status}] ${id} · ${agent.turns} turns · ${duration(agent.endedAt - agent.startedAt)}`;
		const activity = agent.tools.size
			? [...agent.tools.values()].map((tool) => `${tool.name} ${duration(now - tool.since)}`).join(", ")
			: agent.phase;
		return `[running] ${id} · turn ${agent.turns + 1} · ${activity} · last event ${duration(now - agent.lastEventAt)} ago · ${duration(now - agent.startedAt)}`;
	};

	const noticeLine = (agent: Agent) => (agent.notices.length ? `Notices: ${agent.notices.join(" | ")}` : "");

	/** The model-facing report. */
	const report = (agent: Agent) => {
		if (agent.status === "running") {
			return [header(agent), ...agent.narration, noticeLine(agent), "Still running: wait with status, or abort."].filter(Boolean).join("\n");
		}
		const text =
			agent.lastText.length > MAX_RESULT_CHARS
				? `${agent.lastText.slice(0, MAX_RESULT_CHARS)}\n…[truncated; full reply: ${join(agent.dir, "final.md")}]`
				: agent.lastText;
		return [header(agent), agent.woken, agent.error, noticeLine(agent), text].filter(Boolean).join("\n\n");
	};

	/**
	 * A tool result showing the final state delivers it; a delivered result is not repeated.
	 * Pending messages reach the parent after the tool result, so the final result then goes out as a message
	 * behind that subagent's own, keeping it the last word.
	 */
	const consume = (agent: Agent) => {
		if (agent.status === "running") return report(agent) + (loud() ? "\nReturned early: subagent messages follow this result." : "");
		if (agent.status === "stopped") return header(agent);
		if (pending.some((message) => message.agentId === agent.id)) deliver(agent);
		if (agent.delivered) return `${header(agent)}\n\nIts result ${agent.delivered}. Full reply: ${join(agent.dir, "final.md")}`;
		agent.delivered = "was returned to you earlier";
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

	// Pi runs before_agent_start only for prompts, so a run that a message starts gets the board digest just ahead of that message.
	const digestFirst = () => {
		const digest = team.mainDigest();
		if (digest) pi.sendMessage(digest, { triggerTurn: false });
	};

	// An idle parent starts a turn with the message; a busy one gets it at its next turn boundary. A quiet message never starts a turn.
	const notify = (customType: string, agentId: string, text: string, details: object, quiet = false) => {
		if (shuttingDown) return;
		// Providers join consecutive messages into one text; the blank line keeps them apart.
		const content = `${text.trimEnd()}\n\n`;
		const label = `subagent ${agentId}: ${customType.replace(/^subagent-/, "").replace("-", " ")}`;
		if (!parent || parent.isIdle()) {
			const triggers = !suspended && !quiet;
			if (triggers) digestFirst();
			pi.sendMessage({ customType, content, display: true, details }, { triggerTurn: triggers });
			if (suspended && !quiet && parent?.hasUI) parent.ui.notify(`${label} added; the main agent sees it when it runs again`, "info");
			return;
		}
		pending.push({ customType, agentId, content, details, quiet });
		if (quiet) return;
		for (const wake of [...waits]) wake();
		// Visible to the user at once, while the parent may still be inside a long tool call.
		if (parent.hasUI) parent.ui.notify(`${label} waiting for the main agent`, "info");
	};

	const takePending = () => {
		const taken = pending;
		pending = [];
		return taken;
	};

	// Every pending message joins the session in the same request. A model error keeps them for agent_settled,
	// which wakes the parent; an abort (Esc) appends them without asking for another request.
	// Returned entries replace the drafts earlier handlers proposed, so they are kept in front.
	const atBoundary = (event: BoundaryState) => {
		if (!pending.length || event.outcome === "error") return;
		const wakes = loud() > 0;
		const entries = takePending().map(({ customType, content, details }) => ({ type: "custom_message" as const, customType, content, display: true, details }));
		return { entries: [...event.entries, ...entries], continue: event.continue || (wakes && event.outcome !== "aborted") };
	};
	// The board digest rides on a request that follows tool results anyway, so it never makes a run continue.
	pi.on("turn_end", (event) => {
		const result = atBoundary(event);
		const digest = event.outcome === "completed" && event.toolResults.length ? team.mainDigest() : undefined;
		return digest ? { ...result, entries: [...(result?.entries ?? event.entries), digest] } : result;
	});
	pi.on("agent_before_settle", atBoundary);

	// Messages no boundary took, such as those that came during a model error; wake the parent unless it was stopped.
	// One wake for the whole batch: each triggering message would start its own run, which Esc cannot cancel.
	pi.on("agent_settled", (event) => {
		if (event.aborted) suspended = true;
		const wakes = !event.aborted && loud() > 0;
		const taken = takePending();
		if (wakes) digestFirst();
		taken.forEach(({ customType, content, details }, i) => {
			pi.sendMessage({ customType, content, display: true, details }, { triggerTurn: wakes && i === taken.length - 1 });
		});
	});

	pi.on("before_agent_start", () => {
		const digest = team.mainDigest();
		if (digest) return { message: digest };
	});

	// Whoever starts the next run, the user or an extension that continues after its own abort, ends the suspension.
	pi.on("agent_start", () => {
		suspended = false;
	});

	const deliver = (agent: Agent) => {
		if (agent.delivered || shuttingDown) return;
		agent.delivered = "was sent to you as a subagent-result message";
		notify("subagent-result", agent.id, report(agent), { id: agent.id, status: agent.status });
	};

	/**
	 * Resolves once `agent` (if given) stops running, `ms` pass, or `signal` aborts.
	 * A tool wait (`forTool`) also ends on any message pending for the parent.
	 */
	const waitFor = (agent: Agent | undefined, ms: number, signal?: AbortSignal, forTool = false) =>
		new Promise<void>((done) => {
			if ((agent && agent.status !== "running") || ms <= 0 || signal?.aborted || (forTool && loud())) return done();
			const end = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", end);
				agent?.waiters.delete(end);
				waits.delete(end);
				done();
			};
			const timer = setTimeout(end, ms);
			signal?.addEventListener("abort", end, { once: true });
			agent?.waiters.add(end);
			if (forTool) waits.add(end);
		});

	const team = createTeam(pi, {
		isRunning: (name) => agents.get(name)?.status === "running",
		startedBy: (name) => agents.get(name)?.startedBy ?? MAIN,
		locked: (name) => Boolean(agents.get(name)?.locked),
		wake: (name, by) => {
			const agent = agents.get(name) as Agent;
			if (by === MAIN) agent.locked = false;
			const note =
				by === MAIN
					? "The main agent sent you a team message. Act on your team messages."
					: `${by} sent you a team message. Act on your team messages; your final reply is sent to ${by}.`;
			launch(agent, note, by);
		},
		notify,
		// Information for the main agent's judgment, so it never starts a turn.
		notice: (customType, text, details) => notify(customType, "team", text, details, true),
		waitForMain: async (ms, signal) => {
			await waitFor(undefined, ms, signal, true);
			return loud();
		},
	});

	const answer = async (agent: Agent, request: Request, signal: AbortSignal): Promise<Reply> => {
		if (shuttingDown) return { error: "the main agent's session is ending" };
		if (request.op === "start") agent.greeted = true;
		return team.answer(agent.id, request, signal);
	};

	const onEvent = (agent: Agent, event: any) => {
		agent.lastEventAt = Date.now();
		switch (event.type) {
			case "agent_start":
				// A member asks for its preamble before its first run starts.
				if (!agent.greeted) agent.run?.fail("the team extension did not load in the subagent; it needs this extension and its team tool");
				agent.phase = "started";
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
			case "tool_execution_start":
				agent.tools.set(event.toolCallId, { name: event.toolName, since: Date.now() });
				return;
			case "tool_execution_end":
				agent.tools.delete(event.toolCallId);
				agent.phase = "finishing turn";
				return;
			case "message_end": {
				if (event.message?.role !== "assistant") return;
				if (event.message.provider && event.message.model) agent.model = `${event.message.provider}/${event.message.model}`;
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
			case "auto_retry_start":
				agent.phase = `retrying (${event.attempt}/${event.maxAttempts}): ${oneLine(event.errorMessage ?? "", 120)}`;
				return;
			case "compaction_start":
				agent.phase = "compacting";
				return;
			case "extension_ui_request":
				// Startup notices, such as an extension announcing itself, say nothing about this run.
				if (event.method === "notify" && agent.phase !== "starting") agent.notices = [...agent.notices, oneLine(String(event.message ?? ""), NARRATION_CHARS)].slice(-NOTICES);
				return;
		}
	};

	const onEnd = (agent: Agent, status: RunStatus, error: string | null) => {
		Object.assign(agent, { status, error, endedAt: Date.now() });
		agent.tools.clear();
		try {
			writeFileSync(join(agent.dir, "final.md"), agent.lastText);
		} catch {
			// The report still carries the reply.
		}
		const starter = agent.startedBy;
		// A finished run started by a member reaches the main agent only when that member had stopped.
		if (starter !== MAIN) agent.woken = `(woken by ${starter}; ${starter} had stopped)`;
		if (starter !== MAIN && agents.get(starter)?.status === "running" && !shuttingDown) {
			const path = join(agent.dir, "final.md");
			const reply = [agent.error, noticeLine(agent), agent.lastText].filter(Boolean).join("\n\n");
			const intro = `Final reply of ${agent.id} (${status}); full text: ${path}\n\n`;
			const room = BODY_CHARS - intro.length;
			try {
				const seq = team.reply(agent.id, starter, intro + (reply.length > room ? `${reply.slice(0, room - 1)}…` : reply));
				agent.delivered = `was sent to ${starter} as team message #${seq}`;
			} catch (error) {
				// Such as a failed team log write; the main agent gets the result instead.
				agent.woken = `(woken by ${starter}; sending the final reply to ${starter} failed: ${error instanceof Error ? error.message : String(error)})`;
			}
		}
		const waiting = agent.waiters.size > 0;
		for (const wake of [...agent.waiters]) wake();
		if (!waiting) deliver(agent);
	};

	/** Starts a run on `message` once the previous run's process has exited; the member counts as running at once. */
	const launch = (agent: Agent, message: string, startedBy: string) => {
		if (shuttingDown) throw new Error("the session is ending; no new subagent processes start");
		// A finished result no one took yet, such as one an abort call still waits to return, would be lost to the reset.
		if (agent.status !== "running" && agent.status !== "stopped") deliver(agent);
		Object.assign(agent, {
			status: "running",
			startedBy,
			startedAt: Date.now(),
			lastEventAt: Date.now(),
			turns: 0,
			phase: "starting",
			narration: [],
			notices: [],
			lastText: "",
			model: "",
			error: null,
			delivered: null,
			greeted: false,
			woken: "",
		});
		agent.tools.clear();
		const launching = {};
		agent.launching = launching;
		const start = () => {
			// abort cancelled this launch, or a later one replaced it.
			if (agent.launching !== launching) return;
			agent.launching = null;
			if (shuttingDown) return void (agent.status = "stopped");
			const run = startRun({
				cwd: agent.cwd,
				args: agent.launchArgs,
				message,
				owner: {
					onEvent: (event) => onEvent(agent, event),
					onRequest: (request, signal) => answer(agent, request, signal),
					onEnd: (status, error) => onEnd(agent, status, error),
				},
			});
			agent.run = run;
			// After exit, so a tool call waiting on this run has taken its result before a wake starts the next run.
			void run.exited.then(() => {
				if (agent.run === run) agent.run = undefined;
				if (agent.status !== "running" && !shuttingDown) team.afterRun(agent.id);
			});
		};
		if (agent.run) void agent.run.exited.then(start);
		else start();
	};

	const register = (id: string, cwd: string, dir: string, launchArgs: string[], status: Status) => {
		const agent: Agent = {
			id,
			cwd,
			dir,
			launchArgs,
			status,
			startedAt: 0,
			endedAt: 0,
			lastEventAt: 0,
			turns: 0,
			phase: "",
			tools: new Map(),
			narration: [],
			notices: [],
			lastText: "",
			model: "",
			error: null,
			delivered: null,
			greeted: false,
			startedBy: MAIN,
			woken: "",
			locked: false,
			launching: null,
			waiters: new Set(),
		};
		agents.set(id, agent);
		return agent;
	};

	const create = (params: Params, ctx: ExtensionContext): Agent => {
		if (!params.message) throw new Error("run requires message");
		const cwd = resolve(ctx.cwd, params.cwd ?? ".");
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
		const args = params.args ?? [];
		const owned = args.find((arg) => OWNED_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
		if (owned) throw new Error(`args must not include ${owned}; the extension sets the mode, session, and model (use the model parameter)`);
		const model = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}:${pi.getThinkingLevel()}` : undefined);
		const modelArgs = model ? ["--model", model] : [];
		if (!params.name) throw new Error("run requires name: the new member's name");
		if (removesTool(args, "team")) throw new Error("these args remove the team tool, which every member needs");
		const dir = join(sessionBase(ctx), "subagents", params.name);
		const launchArgs = ["--session-dir", dir, "--session-id", params.name, ...modelArgs, ...args];
		team.hire(params.name, params.description ?? "", cwd, launchArgs);
		mkdirSync(dir, { recursive: true });
		return register(params.name, cwd, dir, launchArgs, "running");
	};

	const parameters = Type.Object({
		action: StringEnum(["run", "status", "abort"] as const),
		id: Type.Optional(Type.String({ description: "status, abort: the subagent id, which is the member's name." })),
		message: Type.Optional(Type.String({ description: "run: the task." })),
		name: Type.Optional(
			Type.String({ description: "run (required): the new member's name, 2-24 lowercase letters, digits, or hyphens, starting with a letter. Each name is used once." }),
		),
		description: Type.Optional(
			Type.String({
				description: `run (required): the member's lasting role in one line of up to ${DESCRIPTION_CHARS} characters, not its current task; for example "runs the e2e suite and reports failures".`,
			}),
		),
		model: Type.Optional(Type.String({ description: "run: Pi model pattern, provider/id[:thinking]. Default: your current model and thinking level." })),
		cwd: Type.Optional(Type.String({ description: "run: working directory. Default: yours." })),
		args: Type.Optional(Type.Array(Type.String(), { description: "run: extra Pi CLI options, for example tools, extensions, skills, or MCP." })),
		waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, description: `run, status: wait up to this long. Default ${DEFAULT_WAIT_MS}.` })),
	});
	type Params = {
		action: "run" | "status" | "abort";
		id?: string;
		message?: string;
		name?: string;
		description?: string;
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
			"run hires a named team member, announces it on the board, and starts it on message; its name is its id, and its description is the role the team roster shows. status reports progress or the result (without id: lists subagents). abort stops the current run; a member you aborted wakes only for your direct message.",
			`run and status wait up to waitMs (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}) and return the result if it finishes in time, otherwise its progress while it keeps running. A finished result you have not seen arrives later as a message; do not poll for it. Team messages for you arrive the same way.`,
			"Members talk with you and each other through the team tool. A member starts with an empty conversation, so put the context it needs in message. A direct team message to a stopped member wakes it in its own session. A run woken by a member's message sends its final reply to that member, or to you when that member has stopped.",
			"args are Pi command-line options: read docs/cli.md in the Pi documentation listed in your system prompt, or run `pi --help`. Session, mode, and model flags are set by this tool.",
			"Progress showing no active tool and an old last event suggests a stall. Subagents cannot delegate further and end with this session.",
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
				launch(agent, params.message as string, MAIN);
				await waitFor(agent, waitMs, signal, true);
				return plain(consume(agent) + footer(agent));
			}
			const agent = agents.get(params.id ?? "");
			if (!agent) throw new Error(`Unknown subagent id: ${params.id}. Known: ${[...agents.keys()].join(", ") || "none"}`);
			const text = (body: string) => plain(body + footer(agent));
			if (params.action === "status") {
				await waitFor(agent, waitMs, signal, true);
				return text(consume(agent));
			}
			// This call returns the final state, so hold a waiter to keep it from also being delivered.
			const hold = () => {};
			agent.waiters.add(hold);
			try {
				if (agent.status === "running") agent.locked = true;
				if (agent.launching) {
					// A wake still waiting for the previous process to exit: it never starts.
					agent.launching = null;
					onEnd(agent, "aborted", null);
				} else await agent.run?.stop(signal);
			} finally {
				agent.waiters.delete(hold);
			}
			return text(consume(agent));
		},
	});

	pi.on("session_start", (_event, ctx) => {
		parent = ctx;
		const base = sessionBase(ctx);
		for (const member of team.load(base, ctx)) register(member.name, member.cwd, join(base, "subagents", member.name), member.args, "stopped");
	});

	// Waits for the children: Pi exits the process right after shutdown, which would drop pending kill timers.
	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		await Promise.all([...agents.values()].flatMap((agent) => (agent.run ? [agent.run.shutdown()] : [])));
	});
}
