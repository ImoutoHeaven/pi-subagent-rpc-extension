/**
 * Inside a subagent: the team tool and inbox pulls at safe points, both answered by the parent.
 * There is no subagent tool here, which keeps delegation one level deep.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_WAIT_MS, type Delivery, MAX_WAIT_MS, type Reply, type Request, TAG, TEAM_DESCRIPTION, TEAM_MESSAGE, teamCursor, teamParameters } from "./protocol.ts";

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

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }], details: undefined });

export default function setupChild(pi: ExtensionAPI) {
	/** The team's id, from the start reply. */
	let teamId = "";
	/** The highest team message seq this member has received. */
	let after = 0;

	const draft = (message: Delivery) => ({
		type: "custom_message" as const,
		customType: TEAM_MESSAGE,
		content: message.text,
		display: true,
		details: { team: teamId, seq: message.seq, from: message.from },
	});

	pi.registerTool({
		name: "team",
		label: "Team",
		description: TEAM_DESCRIPTION,
		parameters: teamParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.action === "wait") {
				const ms = Math.min(params.ms ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
				const { count } = await ask(ctx, { op: "wait", after, ms }, signal, ms + WAIT_SLACK_MS);
				return text(count ? `${count} team message(s) for you follow this result.` : `No team messages for you within ${ms}ms.`);
			}
			return text((await ask(ctx, { op: "team", ...params }, signal)).text ?? "");
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const { team: id = "", preamble = "" } = await ask(ctx, { op: "start" }, ctx.signal);
		teamId = id;
		after = teamCursor(ctx.sessionManager.getEntries(), teamId);
		const { messages = [] } = await ask(ctx, { op: "inbox", after }, ctx.signal);
		after = messages.at(-1)?.seq ?? after;
		return {
			message: { customType: TEAM_MESSAGE, content: [preamble, ...messages.map((m) => m.text)].join(""), display: true, details: { team: teamId, seq: after } },
		};
	});

	// Messages ride on a request the model makes anyway: one that follows tool results.
	pi.on("turn_end", async (event, ctx) => {
		if (event.outcome !== "completed" || !event.toolResults.length) return;
		const { messages = [] } = await ask(ctx, { op: "inbox", after }, ctx.signal);
		if (!messages.length) return;
		after = messages[messages.length - 1].seq;
		return { entries: [...event.entries, ...messages.map(draft)] };
	});
}
