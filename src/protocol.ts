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
	with: Type.Optional(Type.String({ description: "history: a member name, or main, to read your direct messages with them; the main agent reads all of that member's direct messages. Omit for the board." })),
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
	/**
	 * `seen`: the seqs of the team messages that the member's current branch holds; the reply holds the messages for the member that it lacks.
	 * `board`: the branch's board cursor; with it, the reply also holds a one-line digest of the board posts after it that `seen` lacks,
	 * and the cursor that digest moves it to.
	 */
	| { op: "inbox"; seen: number[]; board?: number }
	| { op: "wait"; seen: number[]; ms: number }
	| ({ op: "team" } & TeamParams);

/** `board`: the caller's board cursor after a digest. `covered`: the seqs of the messages a history call showed. */
export type Reply =
	| { ok: true; text?: string; team?: string; preamble?: string; messages?: Delivery[]; count?: number; board?: number; covered?: number[] }
	| { error: string };

export type Details = Record<string, unknown> | undefined;

/** The details of a custom message or tool result entry, where the extension keeps what a branch has seen. */
export const detailsOf = (entry: SessionEntry) =>
	(entry.type === "custom_message" ? entry.details : entry.type === "message" && entry.message.role === "toolResult" ? entry.message.details : undefined) as Details;

/** The board cursor of `entries`, a session's current branch, for team `team`: the highest `board` in their details, which every digest carries. */
export const boardCursor = (entries: SessionEntry[], team: string) =>
	entries.reduce((max, entry) => {
		const details = detailsOf(entry);
		const value = details?.team === team ? details.board : undefined;
		return typeof value === "number" && value > max ? value : max;
	}, 0);

/**
 * The seqs of team `team`'s messages whose text the entries with `details` hold: delivered or sent (`seq`),
 * or delivered at a member's run start, shown by history, or counted by a notice (`covered`).
 */
export const seenIn = (details: Details[], team: string) => {
	const seqs = new Set<number>();
	for (const item of details) {
		if (item?.team !== team) continue;
		if (typeof item.seq === "number") seqs.add(item.seq);
		if (Array.isArray(item.covered)) for (const seq of item.covered) seqs.add(seq);
	}
	return seqs;
};
