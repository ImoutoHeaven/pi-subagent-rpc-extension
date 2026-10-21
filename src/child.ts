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
	notesIn,
	type Reply,
	type Request,
	SEEN_ENTRY,
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
	/** The seqs of the team messages, and the ids of the notices, the current branch holds. */
	const held = (ctx: ExtensionContext) => {
		const details = ctx.sessionManager.getBranch().map(detailsOf);
		return { seen: [...seenIn(details, teamId)], notes: [...notesIn(details, teamId)] };
	};

	/**
	 * Pulls the messages the branch lacks and, with `digest`, the board digest and the cursor it moves to; notices and the digest carry seq 0.
	 * At a safe point (`boundary`), `stop` asks the run to end there.
	 */
	const pull = async (ctx: ExtensionContext, digest = false, boundary = false) => {
		const board = digest ? { board: boardCursor(ctx.sessionManager.getBranch(), teamId) } : {};
		const { messages = [], board: cursor, stop } = await ask(ctx, { op: "inbox", ...held(ctx), ...board, ...(boundary ? { boundary } : {}) }, ctx.signal);
		return { messages, cursor, stop };
	};

	// Pi appends a batch entry by entry, and the digest comes last; only that entry carries the board cursor, so an interrupted append never marks the digest seen.
	const drafts = (messages: Delivery[], cursor?: number) =>
		messages.map((message, i) => ({
			type: "custom_message" as const,
			customType: TEAM_MESSAGE,
			content: message.text,
			display: true,
			details: {
				team: teamId,
				seq: message.seq,
				from: message.from,
				...(message.note ? { note: message.note } : {}),
				...(cursor !== undefined && i === messages.length - 1 ? { board: cursor } : {}),
			},
		}));

	pi.registerTool({
		name: "team",
		label: "Team",
		description: TEAM_DESCRIPTION,
		parameters: teamParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.action === "wait") {
				const ms = Math.min(params.ms ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
				return text((await ask(ctx, { op: "wait", ...held(ctx), ms }, signal, ms + WAIT_SLACK_MS)).text ?? "");
			}
			const reply = await ask(ctx, { op: "team", ...params }, signal);
			// An entry of its own, since a call made through another tool, such as codemode, returns no details.
			if (reply.covered?.length) pi.appendEntry(SEEN_ENTRY, { team: teamId, covered: reply.covered });
			return text(reply.text ?? "");
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const { team: id = "", preamble = "" } = await ask(ctx, { op: "start" }, ctx.signal);
		teamId = id;
		const { messages, cursor } = await pull(ctx, true);
		const covered = messages.flatMap((m) => (m.seq ? [m.seq] : []));
		const notes = messages.flatMap((m) => (m.note ? [m.note] : []));
		return {
			message: { customType: TEAM_MESSAGE, content: [preamble, ...messages.map((m) => m.text)].join(""), display: true, details: { team: teamId, covered, notes, board: cursor } },
		};
	});

	// Messages ride on a request the model makes anyway: one that follows tool results. That point is also where the main agent's
	// abort or compaction stops the run, and its switch takes effect, between finished tool calls and the next model request.
	pi.on("turn_end", async (event, ctx) => {
		if (event.outcome !== "completed" || !event.toolResults.length) return;
		const { messages, cursor, stop } = await pull(ctx, true, true);
		if (stop) return ctx.abort();
		if (messages.length) return { entries: [...event.entries, ...drafts(messages, cursor)] };
	});

	// A compaction the main agent asked for may carry its message, which joins the session after the summary without starting a run.
	pi.on("session_compact", async (event, ctx) => {
		if (event.reason !== "manual") return;
		const { text: message, keep } = await ask(ctx, { op: "compacted" });
		if (message === undefined) return;
		const content = `[team] main → you (direct), written after the compaction for your next run:\n${message}\n\n`;
		// The main agent counts the message kept once Pi reports it appended, by `keep`.
		pi.sendMessage({ customType: TEAM_MESSAGE, content, display: true, details: { from: "main", keep } }, { triggerTurn: false });
	});

	// A message that arrived while the member wrote its final reply continues the same run; a digest alone never does, so it is not asked for.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed") return;
		const { messages } = await pull(ctx);
		if (messages.length) return { entries: [...event.entries, ...drafts(messages)], continue: true };
	});
}
