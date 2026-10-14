/**
 * Inside a subagent: the team tool and inbox pulls at safe points, both answered by the parent.
 * There is no subagent tool here, which keeps delegation one level deep.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	boardCursor,
	DEFAULT_WAIT_MS,
	type Delivery,
	detailsOf,
	MAX_WAIT_MS,
	type Reply,
	type Request,
	seenIn,
	TAG,
	TEAM_DESCRIPTION,
	TEAM_MESSAGE,
	teamParameters,
} from "./protocol.ts";

const REQUEST_TIMEOUT_MS = 10_000;
/** How much longer than the wait itself a `wait` request may take. */
const WAIT_SLACK_MS = 5_000;

async function ask(ctx: ExtensionContext, request: Request, signal?: AbortSignal, timeout = REQUEST_TIMEOUT_MS) {
	const value = await ctx.ui.input(TAG, JSON.stringify(request), { signal, timeout });
	if (value === undefined) throw new Error("the main agent did not answer");
	const reply = JSON.parse(value) as Reply;
	if ("error" in reply) throw new Error(reply.error);
	return reply;
}

const text = (body: string, details?: object) => ({ content: [{ type: "text" as const, text: body }], details });

export default function setupChild(pi: ExtensionAPI) {
	/** The team's id, from the start reply. */
	let teamId = "";
	// Read state comes from the current branch at every pull: Pi can drop a batch of boundary entries, and the next pull then returns it again.
	/** The seqs of the team messages the current branch holds. */
	const seen = (ctx: ExtensionContext) => [...seenIn(ctx.sessionManager.getBranch().map(detailsOf), teamId)];

	/** Pulls the messages the branch lacks and, with `digest`, the board digest and the cursor it moves to; notices and the digest carry seq 0. */
	const pull = async (ctx: ExtensionContext, digest = false) => {
		const board = digest ? { board: boardCursor(ctx.sessionManager.getBranch(), teamId) } : {};
		const { messages = [], board: cursor } = await ask(ctx, { op: "inbox", seen: seen(ctx), ...board }, ctx.signal);
		return { messages, cursor };
	};

	// Pi appends a batch entry by entry, and the digest comes last; only that entry carries the board cursor, so an interrupted append never marks the digest seen.
	const drafts = (messages: Delivery[], cursor?: number) =>
		messages.map((message, i) => ({
			type: "custom_message" as const,
			customType: TEAM_MESSAGE,
			content: message.text,
			display: true,
			details: { team: teamId, seq: message.seq, from: message.from, ...(cursor !== undefined && i === messages.length - 1 ? { board: cursor } : {}) },
		}));

	pi.registerTool({
		name: "team",
		label: "Team",
		description: TEAM_DESCRIPTION,
		parameters: teamParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.action === "wait") {
				const ms = Math.min(params.ms ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
				const { count } = await ask(ctx, { op: "wait", seen: seen(ctx), ms }, signal, ms + WAIT_SLACK_MS);
				return text(count ? `${count} team message(s) for you follow this result.` : `No team messages for you within ${ms}ms.`);
			}
			const reply = await ask(ctx, { op: "team", ...params }, signal);
			if (!reply.covered) return text(reply.text ?? "");
			return text(reply.text ?? "", { team: teamId, covered: reply.covered });
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const { team: id = "", preamble = "" } = await ask(ctx, { op: "start" }, ctx.signal);
		teamId = id;
		const { messages, cursor } = await pull(ctx, true);
		const covered = messages.flatMap((m) => (m.seq ? [m.seq] : []));
		return {
			message: { customType: TEAM_MESSAGE, content: [preamble, ...messages.map((m) => m.text)].join(""), display: true, details: { team: teamId, covered, board: cursor } },
		};
	});

	// Messages ride on a request the model makes anyway: one that follows tool results.
	pi.on("turn_end", async (event, ctx) => {
		if (event.outcome !== "completed" || !event.toolResults.length) return;
		const { messages, cursor } = await pull(ctx, true);
		if (messages.length) return { entries: [...event.entries, ...drafts(messages, cursor)] };
	});

	// A compaction the main agent asked for may carry its message, which joins the session after the summary without starting a run.
	pi.on("session_compact", async (event, ctx) => {
		if (event.reason !== "manual") return;
		const { text: message } = await ask(ctx, { op: "compacted" });
		if (message === undefined) return;
		const content = `[team] main → you (direct), written after the compaction for your next run:\n${message}\n\n`;
		pi.sendMessage({ customType: TEAM_MESSAGE, content, display: true, details: { from: "main" } }, { triggerTurn: false });
	});

	// A message that arrived while the member wrote its final reply continues the same run; a digest alone never does, so it is not asked for.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed") return;
		const { messages } = await pull(ctx);
		if (messages.length) return { entries: [...event.entries, ...drafts(messages)], continue: true };
	});
}
