/**
 * The contract between a subagent (child.ts) and the parent that spawned it.
 * A child sends a request as an `input` dialog titled TAG with the JSON request as its placeholder;
 * the parent answers with the JSON reply as the dialog value.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

export const TAG = "pi-subagent/1";
/** Set in every subagent's environment. */
export const CHILD_ENV = "PI_SUBAGENT_CHILD";
/** Custom message type of team messages and of a member's preamble. */
export const TEAM_MESSAGE = "team-message";
export const DEFAULT_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 240_000;
export const BODY_CHARS = 4_000;
export const TOPIC_CHARS = 2_000;

export const teamParameters = Type.Object({
	action: StringEnum(["send", "history", "wait", "members", "topic"] as const),
	body: Type.Optional(
		Type.String({ description: `send: the message, up to ${BODY_CHARS} characters. topic: the new topic, up to ${TOPIC_CHARS}. Put larger content in a file in the shared working tree and give its path.` }),
	),
	to: Type.Optional(Type.String({ description: "send: a member name, or main, for a direct message. Omit to post to the board." })),
	mentions: Type.Optional(Type.Array(Type.String(), { description: 'send to the board: members to notify. Only the main agent can use ["all"].' })),
	replyTo: Type.Optional(Type.Integer({ description: "send: the #seq of the message this answers; its author is notified." })),
	with: Type.Optional(Type.String({ description: "history: a member name, or main, to read your direct messages with them. Omit for the board." })),
	query: Type.Optional(Type.String({ description: "history: only messages containing this text." })),
	before: Type.Optional(Type.Integer({ description: "history: only messages older than this #seq." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "history: at most this many messages. Default 20." })),
	ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, description: `wait: how long to wait. Default ${DEFAULT_WAIT_MS}.` })),
});
export type TeamParams = Static<typeof teamParameters>;

export const TEAM_DESCRIPTION = [
	"Talk with your team: the main agent (main) and the members it started.",
	"send posts to the shared board (no `to`) or sends a direct message (`to`). A board post notifies the members in `mentions` and the author of `replyTo`. Everyone else gets a one-line digest of new board posts after tool results and when a run starts; history shows them in full. A running member reads its messages after its next tool results, or before its run ends. A direct message wakes a stopped member, which then runs in its own session; board posts never wake. A run started by a member's message cannot wake others, and a member the main agent aborted wakes only for the main agent. The send result shows each recipient's state. A run started by a member's message sends its final reply to that member.",
	"history reads the board, or your direct messages with `with`. wait returns once a message for you is pending; the messages follow the tool result. members lists members with their roles and states, and the topic. topic sets the topic (main agent only).",
].join("\n\n");

/** One team message, rendered for its recipient; a notice from the team itself has seq 0. */
export interface Delivery {
	seq: number;
	from: string;
	text: string;
}

export type Request =
	| { op: "start" }
	/** `digest`: also return a one-line digest of unseen board posts. */
	| { op: "inbox"; after: number; digest?: boolean }
	| { op: "wait"; after: number; ms: number }
	| ({ op: "team" } & TeamParams);

export type Reply = { ok: true; text?: string; team?: string; preamble?: string; messages?: Delivery[]; count?: number } | { error: string };

/**
 * The read cursor of a session for `team`: the highest seq of that team's messages it holds.
 * Every team message carries `details: { team, seq }`; `team` is the id of the session that owns the team.
 */
export const teamCursor = (entries: SessionEntry[], team: string) =>
	entries.reduce((max, entry) => {
		const details = entry.type === "custom_message" && entry.customType === TEAM_MESSAGE ? (entry.details as { team?: unknown; seq?: unknown } | undefined) : undefined;
		return details?.team === team && typeof details.seq === "number" && details.seq > max ? details.seq : max;
	}, 0);
