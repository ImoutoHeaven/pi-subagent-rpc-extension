/**
 * The parent side: the `subagent` tool, the agent registry, waits, and delivery of results and team messages
 * to the main agent.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type BoundaryState,
	calculateContextTokens,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SessionEntry,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BODY_CHARS, DEFAULT_WAIT_MS, type Details, detailsOf, MAX_WAIT_MS, type Reply, type Request } from "./protocol.ts";
import { type AbortedBy, type Launch, type Run, type RunStatus, startRun } from "./rpc.ts";
import { createTeam, DESCRIPTION_CHARS } from "./team.ts";

const MAX_RESULT_CHARS = 16_000;
const INSTRUCTIONS_CHARS = 4_000;
const NARRATION_LINES = 3;
const NARRATION_CHARS = 300;
const ERROR_CHARS = 200;
const ARGS_CHARS = 60;
const NOTICES = 3;
const FOOTER_AGENTS = 3;
const STALE_MS = 60_000;
const IDLE_POLL_MS = 250;
const MAIN = "main";
// The extension owns the child's process mode, session, and model selection.
const OWNED_FLAGS = [
	"--mode",
	"--print",
	"-p",
	"--no-session",
	"--session",
	"--session-id",
	"--session-dir",
	"--continue",
	"-c",
	"--resume",
	"-r",
	"--fork",
	"--export",
	"--model",
	"--provider",
	"--thinking",
];
/** The launch args before a member's model options: --session-dir and --session-id with their values. */
const SESSION_ARGS = 4;
// Where a result for the main agent went.
const SENT = "was sent to you as a subagent-result message";
const RETURNED = "was returned to you earlier";

/**
 * `stopped`: a member restored from the log that has not run in this session yet.
 * `compacting`: a compaction run; `compacted`: one that compacted the member's context, or found nothing to compact.
 */
type Status = RunStatus | "running" | "stopped" | "compacting" | "compacted";

/**
 * A compaction the main agent asked for: Pi's custom instructions, and its message, which the member runs on afterwards (`wake`)
 * or finds in its context after the summary.
 */
interface Compaction {
	instructions?: string;
	message?: string;
	wake: boolean;
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
	/** The running tools by call id; `args` is the call's main argument in one line. */
	tools: Map<string, { name: string; args: string; since: number }>;
	narration: string[];
	/** The last ctx.ui.notify texts of the run's extensions, such as why a watchdog stopped it. */
	notices: string[];
	lastText: string;
	/** The run's tokens and cost, summed over its assistant messages; `input` includes cache writes. */
	usage: Usage;
	/** provider/id the child actually answered with; Pi matches --model fuzzily. */
	model: string;
	/** The run's thinking level, as Pi's state reports it at the run's end; empty until then. */
	thinking: string;
	error: string | null;
	/** The run's last model reply was an error. */
	modelError: boolean;
	/** Pi's automatic retries of a model request in this run. */
	retries: number;
	abortedBy: AbortedBy | undefined;
	/** The run is a compaction run. */
	compactOnly: boolean;
	/** The run's last compaction, such as `compacted 312K→24K (threshold)` or `compaction failed: …`; empty when there was none. */
	compaction: string;
	/** Context tokens after the last model reply or compaction, and the member's compact point; kept across runs, undefined until known. */
	contextTokens?: number;
	compactAt?: number;
	/** A compaction that starts once the current run's process exits. */
	queued: Compaction | null;
	/** The message a compaction run continues with once the member is compacted. */
	next?: string;
	/** The message a compaction run writes after the summary, for the member's next run; `kept` once handed to the member. */
	keep?: string;
	kept: boolean;
	/** Where the final result went, completing "Its result …": SENT, RETURNED, or to the member that woke the run; null until it went somewhere. */
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
	/** The launch args of the current or last run; a switch changes `launchArgs` for the next one. */
	runArgs: string[];
	/** A switch with when: now is stopping the run to start the next one, so the member counts as running throughout. */
	restarting: boolean;
	waiters: Set<() => void>;
	run?: Run;
}

interface Usage {
	input: number;
	output: number;
	cached: number;
	cost: number;
}
const noUsage = (): Usage => ({ input: 0, output: 0, cached: 0, cost: 0 });
const tokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
/** ` · 12.3K in · 8.1K out · 1.2M cached · $0.42`; cached and cost only when there are any, nothing before the first message. */
const usageText = ({ input, output, cached, cost }: Usage) => {
	if (!input && !output && !cached) return "";
	const price = cost <= 0 ? "" : cost < 0.01 ? " · <$0.01" : ` · $${cost.toFixed(2)}`;
	return ` · ${tokens.format(input)} in · ${tokens.format(output)} out${cached ? ` · ${tokens.format(cached)} cached` : ""}${price}`;
};
/** ` · ctx 212K/300K 71%`: the context tokens against the compact point; empty until known. */
const ctxText = ({ contextTokens, compactAt }: { contextTokens?: number; compactAt?: number }) => {
	if (contextTokens === undefined) return "";
	const share = compactAt ? `/${tokens.format(compactAt)} ${Math.round((100 * contextTokens) / compactAt)}%` : "";
	return ` · ctx ${tokens.format(contextTokens)}${share}`;
};

interface Pending {
	customType: string;
	agentId: string;
	content: string;
	/** `delivery` identifies the message on the branch that holds it. */
	details: { delivery: string };
	/** Information only: it joins the session but never starts a turn. */
	quiet: boolean;
}

const oneLine = (text: string, limit: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

/** A tool call's main argument in one line, empty when it has none; other arguments may hold secrets, such as an MCP call's API key. */
const argsLine = (args: any) => {
	const main = ["command", "path", "file_path", "code", "query", "pattern", "url"].map((key) => args?.[key]).find((value) => typeof value === "string");
	return main ? oneLine(main, ARGS_CHARS) : "";
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

/** A Pi model pattern split into the model and its `:level` thinking suffix, if any. */
const withLevel = (pattern?: string) => {
	const suffix = pattern?.match(/^(.+):(off|minimal|low|medium|high|xhigh|max)$/);
	return suffix ? { model: suffix[1], thinking: suffix[2] } : { model: pattern, thinking: undefined };
};

/**
 * A member's launch args split at its model options, the `--model` and `--thinking` the extension writes after the session args;
 * `--thinking` beats a `:level` suffix, as in Pi.
 */
function modelChoice(launchArgs: string[]) {
	let pattern: string | undefined;
	let thinking: string | undefined;
	let end = SESSION_ARGS;
	for (; launchArgs[end] === "--model" || launchArgs[end] === "--thinking"; end += 2) {
		if (launchArgs[end] === "--model") pattern = launchArgs[end + 1];
		else thinking = launchArgs[end + 1];
	}
	const model = withLevel(pattern);
	return { session: launchArgs.slice(0, SESSION_ARGS), args: launchArgs.slice(end), model: model.model, thinking: thinking ?? model.thinking };
}

/** `provider/id:level`, as a status header shows a model. */
const modelLabel = (choice: { model?: string; thinking?: string }) => `${choice.model ?? "its session's model"}${choice.thinking ? `:${choice.thinking}` : ""}`;

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
	 * Messages for a busy parent, in arrival order, until its current branch holds them. They join its session together at the next turn boundary,
	 * outside Pi's steer queue, which hands over one message per model request and is cleared by Esc.
	 */
	let pending: Pending[] = [];
	/** The pending messages, without those the parent's current branch holds. A batch another extension drops at a boundary leaves its messages here. */
	const unreceived = () => {
		if (pending.length && parent) {
			const held = new Set(parent.sessionManager.getBranch().map((entry) => detailsOf(entry)?.delivery));
			pending = pending.filter((message) => !held.has(message.details.delivery));
		}
		return pending;
	};
	/** From agent_start to this extension's agent_settled handler; Pi reports idle while earlier settle handlers run. */
	let inRun = false;
	/** The poll for an idle parent, while messages are pending. */
	let watch: ReturnType<typeof setTimeout> | undefined;
	/** Ends every tool wait, so a new message does not sit behind a long wait. */
	const waits = new Set<() => void>();
	/** Pending messages that wake the parent. */
	const loud = () => unreceived().filter((message) => !message.quiet).length;

	/** A running member, or one in a compaction run. */
	const busy = (agent: Agent) => agent.status === "running" || agent.status === "compacting";

	/** How an ended run ended: who aborted it, or its error and Pi's retries of a failed model request. */
	const outcome = (agent: Agent) => {
		if (agent.status === "aborted") return ` · by ${agent.abortedBy === "extension" ? "an extension" : "main"}`;
		if (agent.status !== "error" || !agent.error) return "";
		const retried = agent.modelError ? ` (Pi retried ${agent.retries} time${agent.retries === 1 ? "" : "s"})` : "";
		return ` · ${oneLine(agent.error, ERROR_CHARS)}${retried}`;
	};

	/** ` · next run: <model>` while a busy member's next run uses other settings than its current one. */
	const nextRun = (agent: Agent) => {
		if (!busy(agent) && !agent.queued) return "";
		const next = modelLabel(modelChoice(agent.launchArgs));
		return next === modelLabel(modelChoice(agent.runArgs)) ? "" : ` · next run: ${next}`;
	};

	const header = (agent: Agent) => statusLine(agent) + nextRun(agent);

	const statusLine = (agent: Agent) => {
		const now = Date.now();
		const id = `subagent ${agent.id}${agent.model ? ` · ${agent.model}${agent.thinking ? `:${agent.thinking}` : ""}` : ""}`;
		const context = ctxText(agent);
		const compaction = agent.compaction ? ` · ${agent.compaction}` : "";
		if (agent.status === "stopped") return `[stopped] ${id}${context}`;
		if (agent.status === "compacting") return `[compacting] ${id} · ${duration(now - agent.startedAt)}${context}`;
		if (agent.status === "compacted") return `[compacted] ${id} · ${duration(agent.endedAt - agent.startedAt)}${context}${compaction}`;
		if (agent.status !== "running") {
			return `[${agent.status}] ${id} · ${agent.turns} turns · ${duration(agent.endedAt - agent.startedAt)}${usageText(agent.usage)}${context}${compaction}${outcome(agent)}`;
		}
		const activity = agent.tools.size
			? [...agent.tools.values()].map((tool) => `${tool.name}${tool.args ? ` (${tool.args})` : ""} ${duration(now - tool.since)}`).join(", ")
			: agent.phase;
		return `[running] ${id} · turn ${agent.turns + 1} · ${activity} · last event ${duration(now - agent.lastEventAt)} ago · ${duration(now - agent.startedAt)}${usageText(agent.usage)}${context}${compaction}`;
	};

	/** Whether a compaction run wrote the main agent's message into the member's context. */
	const keptLine = (agent: Agent) => {
		if (!agent.compactOnly || agent.keep === undefined || busy(agent)) return "";
		return agent.kept ? "Your message waits in its context for its next run." : "Your message was not written to its context: no compaction completed.";
	};

	const noticeLine = (agent: Agent) => (agent.notices.length ? `Notices: ${agent.notices.join(" | ")}` : "");

	/** Marks the run's result seen in the details of an entry that shows it, so a branch without one gets the result again. */
	const runKey = (agent: Agent) => ({ id: agent.id, run: agent.startedAt });

	/** The model-facing report. */
	const report = (agent: Agent) => {
		if (busy(agent)) {
			return [header(agent), ...agent.narration, noticeLine(agent), `Still ${agent.status}: wait with status, or abort.`].filter(Boolean).join("\n");
		}
		const text =
			agent.lastText.length > MAX_RESULT_CHARS
				? `${agent.lastText.slice(0, MAX_RESULT_CHARS)}\n…[truncated; full reply: ${join(agent.dir, "final.md")}]`
				: agent.lastText;
		// The header holds the error in one line; one that does not fit follows in full.
		const error = agent.error && oneLine(agent.error, ERROR_CHARS) !== agent.error ? agent.error : "";
		return [header(agent), agent.woken, error, keptLine(agent), noticeLine(agent), text].filter(Boolean).join("\n\n");
	};

	/**
	 * A tool result showing the final state delivers it; a delivered result is not repeated.
	 * Pending messages reach the parent after the tool result, so the final result then goes out as a message
	 * behind that subagent's own, keeping it the last word.
	 */
	const consume = (agent: Agent): { text: string; details?: object } => {
		if (busy(agent)) return { text: report(agent) + (loud() ? "\nReturned early: subagent messages follow this result." : "") };
		if (agent.status === "stopped") return { text: header(agent) };
		if (unreceived().some((message) => message.agentId === agent.id && !message.quiet)) deliver(agent);
		if (agent.delivered) return { text: `${header(agent)}\n\nIts result ${agent.delivered}. Full reply: ${join(agent.dir, "final.md")}` };
		agent.delivered = RETURNED;
		return { text: report(agent), details: runKey(agent) };
	};

	/** Other running subagents, so a result also shows what is still in flight. */
	const footer = (except?: Agent) => {
		const now = Date.now();
		const running = [...agents.values()].filter((agent) => agent !== except && busy(agent) && !team.isRetired(agent.id));
		if (!running.length) return "";
		const shown = running.slice(0, FOOTER_AGENTS).map((agent) => {
			const quiet = now - agent.lastEventAt;
			return `${agent.id} ${agent.status} ${duration(now - agent.startedAt)}${ctxText(agent)}${quiet > STALE_MS ? ` · no event ${duration(quiet)}` : ""}`;
		});
		const more = running.length > FOOTER_AGENTS ? `, +${running.length - FOOTER_AGENTS} more` : "";
		return `\n\n(Background: ${shown.join(", ")}${more}.)`;
	};

	// The board digest joins the branch just ahead of what starts a run: a prompt, or a message, for which Pi runs no before_agent_start.
	// It joins at once, so a message that arrives before that run starts finds it on the branch.
	const digestFirst = () => {
		const digest = parent && team.mainDigest(parent.sessionManager.getBranch());
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
		pending.push({ customType, agentId, content, details: { ...details, delivery: randomUUID() }, quiet });
		watchIdle();
		if (quiet) return;
		for (const wake of [...waits]) wake();
		// Visible to the user at once, while the parent may still be inside a long tool call.
		if (parent.hasUI) parent.ui.notify(`${label} waiting for the main agent`, "info");
	};

	// Every pending message joins the session in the same request. A model error keeps them for agent_settled,
	// which wakes the parent; an abort (Esc) appends them without asking for another request.
	// Returned entries replace the drafts earlier handlers proposed, so they are kept in front.
	// They stay pending until the branch holds them, so a batch a later extension drops is proposed again at the next boundary.
	const atBoundary = (event: BoundaryState) => {
		const batch = unreceived();
		if (!batch.length || event.outcome === "error") return;
		const wakes = batch.some((message) => !message.quiet);
		const entries = batch.map(({ customType, content, details }) => ({ type: "custom_message" as const, customType, content, display: true, details }));
		return { entries: [...event.entries, ...entries], continue: event.continue || (wakes && event.outcome !== "aborted") };
	};
	// The board digest rides on a request that follows tool results anyway, so it never makes a run continue.
	pi.on("turn_end", (event, ctx) => {
		const result = atBoundary(event);
		const digest = event.outcome === "completed" && event.toolResults.length ? team.mainDigest(ctx.sessionManager.getBranch()) : undefined;
		return digest ? { ...result, entries: [...(result?.entries ?? event.entries), digest] } : result;
	});
	pi.on("agent_before_settle", atBoundary);

	// Messages no boundary took, such as those that came during a model error; wake the parent unless it was stopped.
	// One wake for the whole batch: each triggering message would start its own run, which Esc cannot cancel.
	// sendMessage passes no boundary handler, so no extension drops what it sends, and none of it stays pending.
	const flush = () => {
		const taken = unreceived();
		pending = [];
		const wakes = !suspended && taken.some((message) => !message.quiet);
		if (wakes) digestFirst();
		taken.forEach(({ customType, content, details }, i) => {
			pi.sendMessage({ customType, content, display: true, details }, { triggerTurn: wakes && i === taken.length - 1 });
		});
	};
	pi.on("agent_settled", (event) => {
		inRun = false;
		if (event.aborted) suspended = true;
		flush();
	});

	// Compaction and tree navigation keep the parent busy without a run, so no boundary takes what arrives meanwhile.
	// shortcut: Pi gives extensions no idle event, so this polls until a boundary or an idle parent takes the messages; use such an event once Pi has one.
	const watchIdle = () => {
		watch ??= setTimeout(() => {
			watch = undefined;
			if (shuttingDown || !pending.length) return;
			if (!inRun && parent?.isIdle()) flush();
			else watchIdle();
		}, IDLE_POLL_MS);
	};

	pi.on("before_agent_start", digestFirst);

	// Whoever starts the next run, the user or an extension that continues after its own abort, ends the suspension.
	pi.on("agent_start", () => {
		inRun = true;
		suspended = false;
	});

	// A compaction run's result is information only, unless a message waited on the compaction that failed.
	const deliver = (agent: Agent) => {
		if (agent.delivered || shuttingDown) return;
		agent.delivered = SENT;
		const lost = agent.keep !== undefined && !agent.kept;
		notify("subagent-result", agent.id, report(agent), { ...runKey(agent), status: agent.status }, agent.compactOnly && agent.next === undefined && !lost);
	};

	/** Tells the main agent about a member without starting a turn. */
	const notice = (agent: Agent, text: string) => notify("subagent-notice", agent.id, `[subagent] ${agent.id} ${text}`, { id: agent.id }, true);

	/**
	 * Resolves once `agent` (if given) stops running, `ms` pass, or `signal` aborts.
	 * A tool wait (`forTool`) also ends on any message pending for the parent.
	 */
	const waitFor = (agent: Agent | undefined, ms: number, signal?: AbortSignal, forTool = false) =>
		new Promise<void>((done) => {
			if ((agent && !busy(agent)) || ms <= 0 || signal?.aborted || (forTool && loud())) return done();
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
		isRunning: (name) => agents.get(name)?.status === "running" || Boolean(agents.get(name)?.restarting),
		state: (name) => {
			const agent = agents.get(name);
			const status = agent?.status;
			if (agent?.restarting) return "running";
			if (status === "running" || status === "compacting") return status;
			// From the end of the run until its process exits and the queued compaction starts, so no message wakes the member in between.
			if (agent?.queued) return "compacting";
			return status === "error" || status === "aborted" ? `stopped (${status})` : "stopped";
		},
		startedBy: (name) => agents.get(name)?.startedBy ?? MAIN,
		locked: (name) => Boolean(agents.get(name)?.locked),
		unlock: (name) => {
			(agents.get(name) as Agent).locked = false;
		},
		wake: (name, by) => {
			const agent = agents.get(name) as Agent;
			if (by === MAIN) agent.locked = false;
			else if (agent.status === "error" || agent.status === "aborted") {
				notice(agent, `resumed (woken by ${by}) after its run ${agent.status === "error" ? "ended in an error" : "was aborted"}.`);
			}
			const note =
				by === MAIN
					? "The main agent sent you a team message. Act on your team messages."
					: `${by} sent you a team message. Act on your team messages.`;
			launch(agent, { type: "prompt", message: note }, by);
		},
		notify,
		waitForMain: async (ms, signal) => {
			await waitFor(undefined, ms, signal, true);
			return loud();
		},
	});

	const answer = async (agent: Agent, request: Request, signal: AbortSignal): Promise<Reply> => {
		if (shuttingDown) return { error: "the main agent's session is ending" };
		if (request.op === "start") agent.greeted = true;
		// Only a compaction the main agent asked for carries its message, once.
		if (request.op === "compacted") {
			if (!agent.compactOnly || agent.keep === undefined || agent.kept) return { ok: true };
			agent.kept = true;
			return { ok: true, text: agent.keep };
		}
		return team.answer(agent.id, request, signal);
	};

	/** Records the member's model and, through Pi's settings for its working directory, its compact point. */
	const setModel = (agent: Agent, provider: string, id: string) => {
		if (agent.model === `${provider}/${id}`) return;
		agent.model = `${provider}/${id}`;
		const model = parent?.modelRegistry.find(provider, id);
		if (!model) return;
		try {
			const settings = SettingsManager.create(agent.cwd, getAgentDir()).getCompactionSettings(model);
			const point = settings.enabled ? model.contextWindow - settings.reserveTokens : model.contextWindow;
			agent.compactAt = point > 0 ? point : undefined;
		} catch {
			// Invalid compaction settings, which the member's Pi reports itself.
		}
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
				agent.tools.set(event.toolCallId, { name: event.toolName, args: argsLine(event.args), since: Date.now() });
				return;
			case "tool_execution_end":
				agent.tools.delete(event.toolCallId);
				agent.phase = "finishing turn";
				return;
			case "message_end": {
				if (event.message?.role !== "assistant") return;
				if (event.message.provider && event.message.model) setModel(agent, event.message.provider, event.message.model);
				const usage = event.message.usage;
				const stop = event.message.stopReason;
				agent.modelError = stop === "error";
				if (usage) {
					agent.usage.input += (usage.input ?? 0) + (usage.cacheWrite ?? 0);
					agent.usage.output += usage.output ?? 0;
					agent.usage.cached += usage.cacheRead ?? 0;
					agent.usage.cost += usage.cost?.total ?? 0;
					// As Pi counts context: a failed or aborted reply carries no valid usage.
					const context = stop === "error" || stop === "aborted" ? 0 : calculateContextTokens(usage);
					if (context > 0) agent.contextTokens = context;
				}
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
				agent.retries = event.attempt;
				agent.phase = `retrying (${event.attempt}/${event.maxAttempts}): ${oneLine(event.errorMessage ?? "", 120)}`;
				return;
			case "compaction_start":
				agent.phase = "compacting";
				return;
			case "compaction_end": {
				const { reason, result } = event;
				if (result) {
					agent.contextTokens = result.estimatedTokensAfter;
					agent.compaction = `compacted ${tokens.format(result.tokensBefore)}→${tokens.format(result.estimatedTokensAfter)} (${reason})`;
				} else agent.compaction = `compaction failed: ${event.errorMessage ?? "cancelled"}`;
				// A compaction run reports its own result.
				if (reason !== "manual") notice(agent, `${agent.compaction}${ctxText(agent)}`);
				return;
			}
			case "response": {
				// get_state names the model, also for a compaction run, which has no model reply.
				const model = event.data?.model;
				if (typeof model?.provider === "string" && typeof model.id === "string") setModel(agent, model.provider, model.id);
				if (typeof event.data?.thinkingLevel === "string") agent.thinking = event.data.thinkingLevel;
				return;
			}
			case "extension_ui_request":
				// Startup notices, such as an extension announcing itself, say nothing about this run.
				if (event.method === "notify" && agent.phase !== "starting") agent.notices = [...agent.notices, oneLine(String(event.message ?? ""), NARRATION_CHARS)].slice(-NOTICES);
				return;
		}
	};

	const onEnd = (agent: Agent, runStatus: RunStatus, runError: string | null, abortedBy?: AbortedBy) => {
		let status: Status = runStatus;
		let error = runError;
		if (agent.compactOnly) {
			// Pi's reasons to have nothing to compact leave the member as compacted as it gets.
			const noop = status === "error" && /^(Nothing to compact|Already compacted)/.test(error ?? "");
			if (noop) agent.compaction = error as string;
			else if (status !== "settled") agent.compaction = "";
			if (status === "settled" || noop) [status, error] = ["compacted", null];
			else if (status === "error") error = `compaction failed: ${error}`;
		}
		Object.assign(agent, { status, error, abortedBy, endedAt: Date.now() });
		agent.tools.clear();
		if (status === "compacted" && agent.next !== undefined && !shuttingDown) {
			// The run on the message is the main agent's task, so it unlocks the member; its header keeps this compaction,
			// and its result is the one delivered.
			const compaction = agent.compaction;
			agent.delivered = "continued";
			agent.locked = false;
			launch(agent, { type: "prompt", message: agent.next }, MAIN);
			agent.compaction = compaction;
			return;
		}
		if (!agent.compactOnly) {
			try {
				writeFileSync(join(agent.dir, "final.md"), agent.lastText);
			} catch {
				// The report still carries the reply.
			}
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
		if (status === "error" && !agent.compactOnly && !shuttingDown) {
			team.stoppedOnError(agent.id, agent.startedAt, starter);
			// The final reply went to the member that started the run; the main agent hears of the error.
			if (agent.delivered) notice(agent, `stopped on an error; its final reply ${agent.delivered}: ${oneLine(error ?? "", ERROR_CHARS)}`);
		}
		const waiting = agent.waiters.size > 0;
		for (const wake of [...agent.waiters]) wake();
		if (!waiting) deliver(agent);
	};

	/** Starts a run on `command` once the previous run's process has exited; the member counts as running or compacting at once. */
	const launch = (agent: Agent, command: Launch, startedBy: string) => {
		if (shuttingDown) throw new Error("the session is ending; no new subagent processes start");
		// A finished result no one took yet, such as one an abort call still waits to return, would be lost to the reset.
		if (!busy(agent) && agent.status !== "stopped") deliver(agent);
		Object.assign(agent, {
			status: command.type === "compact" ? "compacting" : "running",
			compactOnly: command.type === "compact",
			startedBy,
			startedAt: Date.now(),
			lastEventAt: Date.now(),
			turns: 0,
			phase: "starting",
			narration: [],
			notices: [],
			lastText: "",
			usage: noUsage(),
			model: "",
			thinking: "",
			error: null,
			modelError: false,
			retries: 0,
			abortedBy: undefined,
			compaction: "",
			next: undefined,
			keep: undefined,
			kept: false,
			delivered: null,
			greeted: false,
			woken: "",
		});
		agent.tools.clear();
		// A switch from here on is for the next run.
		const args = agent.launchArgs;
		agent.runArgs = args;
		const launching = {};
		agent.launching = launching;
		const start = () => {
			// abort cancelled this launch, or a later one replaced it.
			if (agent.launching !== launching) return;
			agent.launching = null;
			if (shuttingDown) return void (agent.status = "stopped");
			const run = startRun({
				cwd: agent.cwd,
				args,
				launch: command,
				owner: {
					onEvent: (event) => onEvent(agent, event),
					onRequest: (request, signal) => answer(agent, request, signal),
					onEnd: (status, error, abortedBy) => onEnd(agent, status, error, abortedBy),
				},
			});
			agent.run = run;
			// After exit, so a tool call waiting on this run has taken its result before a wake starts the next run.
			// A queued compaction comes first; the direct messages the run left unread are routed once it is over.
			void run.exited.then(() => {
				if (agent.run === run) agent.run = undefined;
				// A restart launches the next run itself, which reads the messages this run left unread.
				if (busy(agent) || agent.restarting || shuttingDown) return;
				const queued = agent.queued;
				agent.queued = null;
				if (queued) compact(agent, queued);
				else team.afterRun(agent.id);
			});
		};
		if (agent.run) void agent.run.exited.then(start);
		else start();
	};

	/** Starts a compaction run, which continues with `message` once the member is compacted. */
	const compact = (agent: Agent, { instructions, message, wake }: Compaction) => {
		launch(agent, { type: "compact", ...(instructions ? { customInstructions: instructions } : {}) }, MAIN);
		if (wake) agent.next = message;
		else agent.keep = message;
	};

	/** Stops the member's run or compaction, if any, and cancels a queued compaction; the caller returns the stopped run's state. */
	const halt = async (agent: Agent, signal?: AbortSignal) => {
		// Held so the stopped run's result is not also delivered.
		const hold = () => {};
		agent.waiters.add(hold);
		try {
			agent.queued = null;
			if (agent.launching) {
				// A wake still waiting for the previous process to exit: it never starts.
				agent.launching = null;
				onEnd(agent, "aborted", null, "main");
			} else await agent.run?.stop(signal);
		} finally {
			agent.waiters.delete(hold);
		}
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
			usage: noUsage(),
			model: "",
			thinking: "",
			error: null,
			modelError: false,
			retries: 0,
			abortedBy: undefined,
			compactOnly: false,
			kept: false,
			compaction: "",
			queued: null,
			delivered: null,
			greeted: false,
			startedBy: MAIN,
			woken: "",
			locked: false,
			launching: null,
			runArgs: launchArgs,
			restarting: false,
			waiters: new Set(),
		};
		agents.set(id, agent);
		return agent;
	};

	const create = (params: Params, ctx: ExtensionContext) => {
		if (!params.message) throw new Error("run requires message");
		const cwd = resolve(ctx.cwd, params.cwd ?? ".");
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
		const args = params.args ?? [];
		const owned = args.find((arg) => OWNED_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
		if (owned) throw new Error(`args must not include ${owned}; the extension sets the mode, session, model, and thinking level (use the model parameter)`);
		const model = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}:${pi.getThinkingLevel()}` : undefined);
		const modelArgs = model ? ["--model", model] : [];
		if (!params.name) throw new Error("run requires name: the new member's name");
		if (removesTool(args, "team")) throw new Error("these args remove the team tool, which every member needs");
		const dir = join(sessionBase(ctx), "subagents", params.name);
		const launchArgs = ["--session-dir", dir, "--session-id", params.name, ...modelArgs, ...args];
		const joined = team.hire(params.name, params.description ?? "", cwd, launchArgs);
		mkdirSync(dir, { recursive: true });
		return { agent: register(params.name, cwd, dir, launchArgs, "running"), joined };
	};

	const parameters = Type.Object({
		action: StringEnum(["run", "status", "abort", "compact", "switch"] as const),
		id: Type.Optional(Type.String({ description: "status, abort, compact, switch: the subagent id, which is the member's name." })),
		message: Type.Optional(
			Type.String({
				description:
					"run: the task. compact: with wake true, a task the member runs once compacted, as if you sent it; with wake false, your message written word for word into its context after the summary, for its next run. switch: a task the member runs at once on the new settings, as if you sent it; for a busy member, with when: now.",
			}),
		),
		instructions: Type.Optional(
			Type.String({
				description: `compact: Pi's custom instructions for the compaction that runs, up to ${INSTRUCTIONS_CHARS} characters; how they shape the summary depends on that compaction.`,
			}),
		),
		wake: Type.Optional(
			Type.Boolean({
				description:
					"compact: true (default) runs the member on message once compacted. false, which requires message, writes message into its context after the summary and leaves it stopped; it reads message when it next runs.",
			}),
		),
		name: Type.Optional(
			Type.String({ description: "run (required): the new member's name, 2-24 lowercase letters, digits, or hyphens, starting with a letter. Each name is used once." }),
		),
		description: Type.Optional(
			Type.String({
				description: `run (required): the member's lasting role in one line of up to ${DESCRIPTION_CHARS} characters, not its current task; for example "runs the e2e suite and reports failures".`,
			}),
		),
		model: Type.Optional(
			Type.String({ description: "run: Pi model pattern, provider/id[:thinking]. Default: your current model and thinking level. switch: the member's new model, in the same form." }),
		),
		thinking: Type.Optional(Type.String({ description: "switch: a Pi thinking level: off, minimal, low, medium, high, xhigh, or max." })),
		when: Type.Optional(
			StringEnum(["now", "next"] as const, {
				description:
					"switch (required while the member runs, compacts, or has a compaction queued): now stops that as abort does and runs the member on message with the new settings at once, and needs message; next applies the settings from its next run. A stopped member ignores it.",
			}),
		),
		retire: Type.Optional(
			Type.Boolean({
				description: "abort (required): true also retires the member: it leaves the team for good, and its name is not reused. false only stops it.",
			}),
		),
		cwd: Type.Optional(Type.String({ description: "run: working directory. Default: yours." })),
		args: Type.Optional(Type.Array(Type.String(), { description: "run: extra Pi CLI options, for example tools, extensions, skills, or MCP." })),
		waitMs: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: MAX_WAIT_MS,
				description: `run, status, compact, switch with message: wait up to this long; 0 returns at once while the member keeps running. Default ${DEFAULT_WAIT_MS}.`,
			}),
		),
	});
	type Params = {
		action: "run" | "status" | "abort" | "compact" | "switch";
		id?: string;
		message?: string;
		instructions?: string;
		name?: string;
		description?: string;
		model?: string;
		thinking?: string;
		retire?: boolean;
		wake?: boolean;
		when?: "now" | "next";
		cwd?: string;
		args?: string[];
		waitMs?: number;
	};

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to a Pi subagent: a separate Pi process with its own session that loads tools, extensions, skills, and MCP servers like a normal Pi launch.",
			"run hires a named team member, announces it on the board, and starts it on message; its name is its id, and its description is the role the team roster shows. status reports progress or the result (without id: lists subagents). abort stops a member's run or compaction, if any, and cancels a queued compaction; a member you aborted wakes only for your direct message. retire (required with abort): true also removes the member from the team, whether it runs or not; retire members you will not use again. A retired member's name is not reused, and status with its id still shows its last result.",
			"Two ways to give work: a fresh member with a self-contained message suits a different domain or a new task; a stopped member, compacted with instructions that keep what helps and then messaged, suits continuing its work, or similar work its earlier context helps with.",
			"compact compacts a member's context; instructions go to the compaction that runs as Pi's custom instructions, and how they shape the summary depends on that compaction. Pi compacts a running member by itself at its compact point, a Pi setting; status lines show ctx: the member's context tokens against that point. Compact a member yourself when it is past about 60% of its compact point and is about to take a new or unrelated task, or holds much that the next task does not need. A stopped member compacts at once, a running one after its current run. With message and wake true (the default), the member then runs on message as if you sent it. With wake false, message is written word for word into its context after the summary, marked as yours, and the member stays stopped until something wakes it; use it for what the member's next task needs word for word, without starting that task. Without message or with wake false, a result you did not wait for arrives without starting a turn, unless your message could not be written.",
			"switch moves a member to another model or thinking level; it keeps its name, session, and context. A stopped member uses the new settings from its next run, and with message runs on them at once. A busy member needs when: next leaves its current run or compaction on the old settings, and its status shows `next run:` until then; now, with message, stops it as abort does and runs it on message with the new settings in the same call. A new model starts without the prompt cache, so its next request pays full input price for the whole context; compact first when the context is large.",
			`run, status, compact, and switch with message wait up to waitMs (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}) and return the result if it finishes in time, otherwise its progress while it keeps running. To wait longer, call status again; each wait of up to ${MAX_WAIT_MS / 60_000} minutes keeps the prompt cache warm. Or end your turn: every result and message for you starts your next turn, and notices that start none arrive with it.`,
			"Members talk with you and each other through the team tool. A member starts with an empty conversation, so put the context it needs in message. A direct team message to a stopped member wakes it in its own session. A run woken by a member's message sends its final reply to that member, or to you when that member has stopped.",
			"args are Pi command-line options: read docs/cli.md in the Pi documentation listed in your system prompt, or run `pi --help`. Session, mode, model, provider, and thinking flags are set by this tool.",
			"Progress showing no active tool and an old last event suggests a stall. Subagents cannot delegate further and end with this session.",
		].join("\n\n"),
		parameters,
		async execute(_toolCallId, params: Params, signal, _onUpdate, ctx) {
			parent = ctx;
			const waitMs = Math.min(params.waitMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
			if (params.wake !== undefined && params.action !== "compact") throw new Error("wake applies to compact only");
			if (params.action === "status" && !params.id) {
				const listed = [...agents.values()].filter((agent) => !team.isRetired(agent.id));
				return { content: [{ type: "text", text: listed.length ? listed.map(header).join("\n") : "No subagents." }], details: undefined };
			}
			/** The state of `agent`, with the other running members; `details` mark what the result shows seen. */
			const result = (agent: Agent, details?: object, lead = "") => {
				const state = consume(agent);
				return { content: [{ type: "text" as const, text: lead + state.text + footer(agent) }], details: { ...details, ...state.details } };
			};
			if (params.action === "run") {
				const { agent, joined } = create(params, ctx);
				launch(agent, { type: "prompt", message: params.message as string }, MAIN);
				await waitFor(agent, waitMs, signal, true);
				return result(agent, joined);
			}
			const agent = agents.get(params.id ?? "");
			if (!agent) throw new Error(`Unknown subagent id: ${params.id}. Known: ${[...agents.keys()].join(", ") || "none"}`);
			if (params.action !== "status" && team.isRetired(agent.id)) throw new Error(`${agent.id} is retired`);
			if (params.action === "status") {
				await waitFor(agent, waitMs, signal, true);
				return result(agent);
			}
			if (params.action === "compact") {
				const instructions = params.instructions?.trim();
				if (instructions && instructions.length > INSTRUCTIONS_CHARS) {
					throw new Error(
						`instructions are ${instructions.length} characters, over ${INSTRUCTIONS_CHARS}; put what the member must keep word for word in message: with wake: true (the default) it runs on message once compacted; with wake: false message stays in its context and it stays stopped`,
					);
				}
				const wake = params.wake ?? true;
				if (!wake && !params.message) throw new Error("compact with wake: false requires message, which the member finds in its context after the summary");
				if (agent.status === "compacting" || agent.queued) throw new Error(`${agent.id} is already compacting or has a compaction queued`);
				const request = { instructions, message: params.message || undefined, wake };
				if (agent.status === "running") {
					agent.queued = request;
					return { content: [{ type: "text", text: `${header(agent)}\n\nCompaction queued after the current run.${footer(agent)}` }], details: undefined };
				}
				compact(agent, request);
				await waitFor(agent, waitMs, signal, true);
				return result(agent);
			}
			if (params.action === "switch") {
				const pattern = params.model?.trim() || undefined;
				const level = params.thinking?.trim() || undefined;
				if (!pattern && !level) throw new Error("switch requires model or thinking");
				const occupied = busy(agent) || Boolean(agent.queued);
				const state = agent.status === "running" ? "running" : "compacting";
				if (occupied && !params.when) throw new Error(`${agent.id} is ${state}: switch requires when: now or next`);
				const now = occupied && params.when === "now";
				if (now && !params.message) throw new Error("switch with when: now requires message, the task the member runs on the new settings");
				// A run on message would replace the current run, or drop a queued compaction.
				if (occupied && !now && params.message) throw new Error(`${agent.id} is ${state}; with message, switch requires when: now, which stops it first`);
				const configured = modelChoice(agent.launchArgs);
				const ran = modelChoice(agent.runArgs);
				const asked = pattern ? withLevel(pattern) : undefined;
				const model = asked?.model ?? configured.model;
				const thinking = level ?? asked?.thinking ?? configured.thinking;
				const target = modelLabel({ model, thinking });
				// Restarting a run on the settings it already uses gains nothing.
				if (target === modelLabel(configured) && (!now || target === modelLabel(ran))) {
					if (params.message) throw new Error(`${agent.id} is already set to ${target}; send it your message with team send`);
					return { content: [{ type: "text", text: `${agent.id} is already set to ${target}.` }], details: undefined };
				}
				const launchArgs = [...configured.session, ...(model ? ["--model", model] : []), ...(thinking ? ["--thinking", thinking] : []), ...configured.args];
				team.relaunch(agent.id, launchArgs);
				agent.launchArgs = launchArgs;
				// The prompt cache belongs to the model of the current or last run.
				const cache =
					model !== ran.model && agent.contextTokens !== undefined
						? ` ctx ${tokens.format(agent.contextTokens)} — its next request pays full input price for that context.`
						: "";
				/** What the member runs or last ran on, as its status header shows it. */
				const was = () => modelLabel({ model: agent.model || ran.model, thinking: agent.thinking || ran.thinking });
				if (!params.message) return { content: [{ type: "text", text: `${agent.id} now runs on ${target} from its next run (was ${was()}).${cache}` }], details: undefined };
				let stopped = "";
				if (now) {
					// Locked as by abort, in case the call is cancelled; counted as running until the next run launches,
					// so no message meanwhile wakes the member or reaches the main agent as stuck.
					agent.locked = true;
					agent.restarting = true;
					try {
						await halt(agent, signal);
					} finally {
						agent.restarting = false;
					}
					if (signal?.aborted) {
						// The user stopped the main agent, so no new work starts: the member ends as aborted. Its exit, if over, skipped routing its unread messages.
						if (!agent.run) team.afterRun(agent.id);
						return result(agent, undefined, `${agent.id} now runs on ${target} from its next run (was ${was()}).${cache} The call was cancelled, so it stopped without running on message.\n\n`);
					}
					stopped = `${consume(agent).text}\n\n`;
				}
				const line = `${agent.id} now runs on ${target} (was ${was()}).${cache}\n\n`;
				// As the main agent's task, the run unlocks the member.
				agent.locked = false;
				launch(agent, { type: "prompt", message: params.message }, MAIN);
				await waitFor(agent, waitMs, signal, true);
				return result(agent, undefined, line + stopped);
			}
			if (typeof params.retire !== "boolean") throw new Error("abort requires retire: true or false");
			// Retired before its run stops, so nothing wakes the member in between.
			if (params.retire) team.retire(agent.id);
			// A queued compaction holds messages until its run's process exits, which then routes them.
			if (busy(agent) || agent.queued) agent.locked = true;
			await halt(agent, signal);
			if (!params.retire) return result(agent);
			const unread = team.unread(agent.id);
			const left = unread.length ? ` ${agent.id} had ${unread.length} unread message${unread.length === 1 ? "" : "s"}: ${unread.map((seq) => `#${seq}`).join(", ")}.` : "";
			return result(agent, undefined, `${agent.id} is retired: it left the team; its session and final.md stay.${left}\n\n`);
		},
	});

	pi.on("session_start", (event, ctx) => {
		parent = ctx;
		const base = sessionBase(ctx);
		for (const member of team.load(base, ctx)) register(member.name, member.cwd, join(base, "subagents", member.name), member.args, "stopped");
		// Nothing is pending yet: a session start makes a new runtime.
		const shown = ctx.sessionManager.getBranch().map(detailsOf);
		if (event.reason === "fork") team.forked(shown);
		team.redeliver(shown);
	});

	// The new branch gets, without a turn, the team messages and results it lacks; messages still pending reach it when they are flushed.
	/** The entries Pi hands the summarizer of the tree navigation in progress; session_tree does not name them. */
	let summarizing: SessionEntry[] = [];
	pi.on("session_before_tree", (event) => {
		summarizing = event.preparation.entriesToSummarize;
	});
	pi.on("session_tree", (event, ctx) => {
		const summarized = event.summaryEntry ? summarizing : [];
		summarizing = [];
		const branch = ctx.sessionManager.getBranch();
		const shown: Details[] = [...branch.map(detailsOf), ...unreceived().map((message) => message.details)];
		team.redeliver(shown, summarized.map(detailsOf));
		for (const agent of agents.values()) {
			if (agent.delivered !== SENT && agent.delivered !== RETURNED) continue;
			if (shown.some((details) => details?.id === agent.id && details.run === agent.startedAt)) continue;
			agent.delivered = SENT;
			pi.sendMessage(
				{ customType: "subagent-result", content: `${report(agent).trimEnd()}\n\n`, display: true, details: { ...runKey(agent), status: agent.status } },
				{ triggerTurn: false },
			);
		}
	});

	// Waits for the children: Pi exits the process right after shutdown, which would drop pending kill timers.
	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		await Promise.all([...agents.values()].flatMap((agent) => (agent.run ? [agent.run.shutdown()] : [])));
	});
}
