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
/** Custom entry type that marks what a tool call showed seen on the branch; tool calls made through other tools return no details of their own. */
export const SEEN_ENTRY = "team-seen";
export const DEFAULT_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 240_000;
export const BODY_CHARS = 8_000;
export const TOPIC_CHARS = 2_000;
export const TITLE_CHARS = 100;

export const teamParameters = Type.Object({
	action: StringEnum(["send", "history", "wait", "members", "topic"] as const),
	title: Type.Optional(
		Type.String({ description: `send to the board: required for a post that starts a thread, the thread's title, one line of at most ${TITLE_CHARS} characters. A reply takes none.` }),
	),
	body: Type.Optional(
		Type.String({ description: `send: the message, up to ${BODY_CHARS} characters. topic: the new topic, up to ${TOPIC_CHARS}. Put larger content in a file in the shared working tree and give its path.` }),
	),
	to: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description: "send: the recipients of a direct message: a member name or main, or a list of them; each recipient sees who else got it. Omit to post to the board.",
		}),
	),
	mentions: Type.Optional(Type.Array(Type.String(), { description: 'send to the board: members to notify. Only the main agent can use ["all"].' })),
	replyTo: Type.Optional(
		Type.Integer({
			description: "send: the #seq of the message this answers; the reply joins its thread and its author is notified. A board post answers a board post; a direct message answers either.",
		}),
	),
	with: Type.Optional(Type.String({ description: "history: a member name, or main, to read your direct messages with them; the main agent reads all of that member's direct messages. Omit for the board." })),
	query: Type.Optional(Type.String({ description: "history: only threads, or direct messages, containing this text." })),
	before: Type.Optional(Type.Integer({ description: "history: only items before this #seq; a thread counts by its latest message." })),
	after: Type.Optional(Type.Integer({ description: "history: only items after this #seq; a board thread counts by its latest message. With thread, continues after this message's #seq." })),
	order: Type.Optional(StringEnum(["newest", "oldest"] as const, { description: "history: which end to list from. Default newest; thread pages always select oldest first." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "history: at most this many items. Default 20, or 50 messages with thread." })),
	thread: Type.Optional(Type.Integer({ description: "history: a #seq; pages its visible thread as a tree, with full message bodies, up to 16000 characters. Follow the returned after cursor to continue." })),
	ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, description: `wait: how long to wait. Default ${DEFAULT_WAIT_MS}.` })),
});
export type TeamParams = Static<typeof teamParameters>;

/** The team tool's description for the main agent (`main`) or a member. */
export const teamDescription = (main: boolean) => [
	"Talk with your team: the main agent (main) and the members it started.",
	"send posts to the shared board (no `to`), or sends one direct message to the members in `to`, and each recipient sees who else got it. A title names a thread: a board post starts one with a title and a body; a reply (`replyTo`), board or direct, joins the thread of the message it answers with only a body. The board is the record; a direct message asks its recipients to act. A board post notifies the members in `mentions` and the author of `replyTo`. Everyone else gets a one-line digest of new board posts by thread after tool results and when a run starts. A running member reads its messages after its next tool results, or before its run ends. A direct message wakes a stopped member, which then runs in its own session; board posts never wake, so to wake the members a post mentions, send them a short direct message that names its #seq instead of repeating the post. A run started by a member's message cannot wake others, and a member the main agent aborted wakes only for the main agent. The send result shows each recipient's state and context use. A run started by a member's message sends its final reply to that member.",
	"history lists board threads by latest activity, or your direct messages with `with`; `thread` shows a page of one thread, selecting oldest messages first and displaying them as a tree. Each page keeps full message bodies within 16000 characters; follow its `More: history thread=... after=...` call until no continuation remains. " +
		(main
			? "wait returns once a message or member result for you is pending; the messages follow the tool result. A wait that a member's end cuts short, because another of your calls returns its result, says so."
			: "wait returns once a message for you is pending; the messages follow the tool result.") +
		" When the team changed since you last saw it, send and wait results end with a Team footer about it: a member's state, or context use passing another 10% of a compact point; a wait that times out with no change lists the busy members, or says nothing changed. members lists members with their roles, states and context use, and the topic. topic sets the topic (main agent only). A member's progress, result, and control (status, abort, compact, switch) belong to the main agent's subagent tool, not to team.",
	"Members see the board and only the direct messages they sent or received; when you point others to a direct message they did not get, quote what they need from it.",
].join("\n\n");

/** One team message, rendered for its recipient; a notice from the team itself has seq 0, and one about the member's messages its `note` id. */
export interface Delivery {
	seq: number;
	from: string;
	text: string;
	note?: string;
}

export type Request =
	| { op: "start" }
	/**
	 * `seen`: the seqs of the team messages that the member's current branch holds; the reply holds the messages for the member that it lacks.
	 * `notes`: the ids of the notices that branch holds; the reply holds the others still pending.
	 * `board`: the branch's board cursor; with it, the reply also holds a one-line digest of the board posts after it that `seen` lacks,
	 * and the cursor that digest moves it to.
	 * `boundary`: the member is at a safe point, between tool results and its next model request; the reply's `stop` asks it to end its run there.
	 */
	| { op: "inbox"; seen: number[]; notes: string[]; board?: number; boundary?: boolean }
	/** `mark`: the id of the latest compaction on the member's branch, or empty; a new one resets what its team footers count as seen. */
	| { op: "wait"; seen: number[]; notes: string[]; ms: number; mark: string }
	/** After a manual compaction: the reply's `text`, if any, is the main agent's message to append after the summary, with `keep` in its details. */
	| { op: "compacted" }
	| ({ op: "team"; mark: string } & TeamParams);

/**
 * `board`: the caller's board cursor after a digest. `covered`: the seqs of the messages a history call showed. `stop`: end the run at this safe point.
 * `keep`: the id that marks the main agent's message after a compaction.
 */
export type Reply =
	| { ok: true; text?: string; team?: string; preamble?: string; messages?: Delivery[]; count?: number; board?: number; covered?: number[]; stop?: boolean; keep?: string }
	| { error: string };

export type Details = Record<string, unknown> | undefined;

/** The id of the latest compaction on a branch, or empty: what a team footer has shown is in context since then. */
export const compactionMark = (entries: SessionEntry[]) => entries.findLast((entry) => entry.type === "compaction")?.id ?? "";

/** The details of a custom message or seen-mark entry, where the extension keeps what a branch has seen. */
export const detailsOf = (entry: SessionEntry) =>
	(entry.type === "custom_message" ? entry.details : entry.type === "custom" && entry.customType === SEEN_ENTRY ? entry.data : undefined) as Details;

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

/** The ids of team `team`'s notices that the entries with `details` hold: one delivered at a boundary (`note`), or at a member's run start (`notes`). */
export const notesIn = (details: Details[], team: string) => {
	const ids = new Set<string>();
	for (const item of details) {
		if (item?.team !== team) continue;
		if (typeof item.note === "string") ids.add(item.note);
		if (Array.isArray(item.notes)) for (const id of item.notes) ids.add(id);
	}
	return ids;
};
