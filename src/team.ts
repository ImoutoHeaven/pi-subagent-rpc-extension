/**
 * Team state: the log, routing, history, the main agent's `team` tool, and answers to members' requests.
 * It has no path to a process: it asks the host about members' runs, wakes members through it, and hands it messages for the main agent.
 */
// Team text reaches the model only as appended session entries; read state lives in details, so no prefix is ever rewritten.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	boardCursor,
	BODY_CHARS,
	DEFAULT_WAIT_MS,
	type Delivery,
	type Details,
	detailsOf,
	MAX_WAIT_MS,
	type Reply,
	type Request,
	SEEN_ENTRY,
	seenIn,
	TEAM_DESCRIPTION,
	TEAM_MESSAGE,
	TITLE_CHARS,
	TOPIC_CHARS,
	type TeamParams,
	teamParameters,
} from "./protocol.ts";

const MAIN = "main";
const BOARD = "team";
/** Custom message type of the main agent's board digest and of the one-line notices about a direct message that could not wake its recipient. */
const TEAM_NOTICE = "team-notice";
const NAME = /^[a-z][a-z0-9-]{0,22}[a-z0-9]$/;
// `team` marks the board in the log's `to` field.
const RESERVED = new Set([MAIN, "all", BOARD]);
const INBOX_SIZE = 10;
const HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 50;
const HISTORY_CHARS = 16_000;
const DIGEST_THREADS = 5;
export const DESCRIPTION_CHARS = 100;
const FORK_NOTICE =
	"[team] The team messages above belong to the team of the session this one was forked from. This session has a team of its own, which starts without members; resume the original session to work with that team.\n\n";

export interface MemberRecord {
	t: "member";
	name: string;
	/** The member's lasting role, in one line. */
	description: string;
	cwd: string;
	args: string[];
}
interface MessageRecord {
	t: "msg";
	seq: number;
	at: number;
	from: string;
	/** The board, or the recipients of a direct message in the order the sender gave. */
	to: typeof BOARD | string[];
	replyTo?: number;
	mentions?: string[];
	notify: string[];
	/** A board post's one-line title. */
	title?: string;
	body: string;
	/** The sender's run was started by a member's message, so the message cannot wake anyone. */
	hop1?: true;
}
interface TopicRecord {
	t: "topic";
	at: number;
	body: string;
}
/** The main agent retired the member: it left the team for good. */
interface RetireRecord {
	t: "retire";
	name: string;
}

export interface TeamHost {
	isRunning(name: string): boolean;
	/** The member's state as the roster shows it: running, compacting, or stopped, with why it stopped or who alone wakes it, such as stopped (error; only main wakes it). */
	state(name: string): string;
	/** Who started the member's current or last run: main, or the member whose message woke it. Main itself: main. */
	startedBy(name: string): string;
	/** The main agent aborted the member, so only its direct message wakes it. */
	locked(name: string): boolean;
	/** Lifts the lock: the main agent's direct message authorizes the member's next run. */
	unlock(name: string): void;
	/** Starts a stopped member's next run for a direct message from `by`. */
	wake(name: string, by: string): void;
	/** Delivers a message to the main agent. */
	notify(customType: string, from: string, text: string, details: object): void;
	/** Resolves with the number of messages pending for the main agent once there is one, or after `ms`. */
	waitForMain(ms: number, signal?: AbortSignal): Promise<number>;
	/** The main agent asked to stop, compact, or switch running member `name` at its next safe point. */
	interrupted(name: string): boolean;
	/** What a wait that timed out shows `name` about the team: what the caller can act on, starting with a blank line, or empty. */
	footer(name: string): string;
}

const jsonLine = (record: object) => `${JSON.stringify(record)}\n`;
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
const text = (body: string, details?: object) => ({ content: [{ type: "text" as const, text: body }], details });

/** The sender and recipients of a direct message; none for a board post. */
const participants = (message: MessageRecord) => (message.to === BOARD ? [] : [message.from, ...message.to]);
const visibleTo = (message: MessageRecord, name: string) => message.to === BOARD || participants(message).includes(name);
/** Whether history shows `message` to `name`: the main agent reads every message. */
const sees = (name: string, message: MessageRecord) => name === MAIN || visibleTo(message, name);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** Recipients given as one string, as some models send them: a name, a JSON array or string, or a comma-separated list. */
const recipientNames = (to: string): string[] => {
	try {
		const parsed: unknown = JSON.parse(to);
		if (Array.isArray(parsed)) return parsed.map(String);
		if (typeof parsed === "string") return [parsed];
	} catch {}
	return to.split(",").map((name) => name.trim()).filter(Boolean);
};
const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
const add = <K, V>(groups: Map<K, V[]>, key: K, value: V) => {
	const group = groups.get(key) ?? [];
	groups.set(key, group);
	group.push(value);
};

export function createTeam(pi: ExtensionAPI, host: TeamHost) {
	/** `<session base>/team.jsonl`, created by the first record written to it. */
	let log = "";
	/** The team's id, the first record of its log; session entries about the team carry it in their details. */
	let teamId = "";
	/** Every member ever hired, the retired ones included; their names are never reused. */
	const members = new Map<string, MemberRecord>();
	const retired = new Set<string>();
	let messages: MessageRecord[] = [];
	/** Each message's thread root by seq: a reply joins the thread of the message it answers. The log is append-only, so a root never changes. */
	const roots = new Map<number, MessageRecord>();
	const rootOf = (message: MessageRecord) => roots.get(message.seq) as MessageRecord;
	/** Adds a message from the log to the team's messages and to `roots`. */
	const track = (message: MessageRecord) => {
		messages.push(message);
		roots.set(message.seq, (message.replyTo !== undefined && roots.get(message.replyTo)) || message);
	};

	/** One message as its viewer reads it; it cites the message it answers and its thread by id. Ends with a blank line, which keeps consecutive messages apart. */
	const render = (message: MessageRecord, viewer: string) => {
		const who = (name: string) => (name === viewer ? "you" : name);
		const route = message.to === BOARD ? `${who(message.from)} → #team` : `${who(message.from)} → ${message.to.map(who).join(", ")} (direct)`;
		const root = rootOf(message);
		const thread = `#${root.seq}${root.title ? ` "${root.title}"` : ""}`;
		const reply = message.replyTo === undefined ? "" : `, replying to ${message.replyTo === root.seq ? thread : `#${message.replyTo} in ${thread}`}`;
		const mentions = message.mentions?.length ? `, mentions ${message.mentions.map(who).join(", ")}` : "";
		return `[team #${message.seq}] ${route}${reply}${mentions}:${message.title ? ` ${message.title}` : ""}\n${message.body}\n\n`;
	};
	let topic = "";
	/** Held `wait` requests by member. */
	const waiters = new Map<string, Set<() => void>>();
	// shortcut: pull marks and sender notices live in memory; a reopened session counts every earlier message as pulled, and every member is stopped then anyway.
	/** Per member, the highest seq its inbox returned; it decides only which messages wake the member again after a run. */
	const pulled = new Map<string, number>();
	/** Per member, the seq of its join announcement, the record after its member record in the log; the member's digest leaves it out. */
	const joined = new Map<string, number>();
	/** Per member, the seq of the message that woke its current or last run; it never wakes the member again. */
	const wokeBy = new Map<string, number>();
	/** Notices for running senders about messages their recipient never read; not log records. */
	const notices = new Map<string, string[]>();
	const lastSeq = () => messages.at(-1)?.seq ?? 0;
	const ping = (name: string) => {
		for (const wake of [...(waiters.get(name) ?? [])]) wake();
	};
	/** Queues a notice for running member `name`'s next pull and ends its wait. */
	const tell = (name: string, text: string) => {
		if (retired.has(name)) return;
		notices.set(name, [...(notices.get(name) ?? []), text]);
		ping(name);
	};

	const append = (...records: (MemberRecord | MessageRecord | TopicRecord | RetireRecord)[]) => {
		// The first write creates the log, which starts with the team's id.
		const id = existsSync(log) ? "" : jsonLine({ t: "team", id: teamId });
		mkdirSync(dirname(log), { recursive: true });
		appendFileSync(log, id + records.map(jsonLine).join(""));
	};
	const details = (message: MessageRecord) => ({ team: teamId, seq: message.seq, from: message.from });

	/** Why `name` cannot use message `seq`: it does not exist, or it is a direct message between others. */
	const unseen = (seq: number) => {
		const message = messages.find((candidate) => candidate.seq === seq);
		if (!message) return `#${seq} does not exist`;
		// A member that took part answers without spending the main agent's context.
		const ask = participants(message).find((name) => name !== MAIN && !retired.has(name)) ?? MAIN;
		return `#${seq} is a direct message between ${list(participants(message))}, which you cannot see; ask ${ask} to forward what you need`;
	};

	/** The members that have not retired. */
	const active = () => [...members.values()].filter((member) => !retired.has(member.name));

	const known = (name: string) => {
		if (name !== MAIN && !members.has(name)) throw new Error(`Unknown member: ${name}. Members: ${[MAIN, ...active().map((member) => member.name)].join(", ")}`);
		return name;
	};
	/** A member a message can name: known and not retired. */
	const recipient = (name: string) => {
		if (retired.has(known(name))) throw new Error(`${name} is retired`);
		return name;
	};

	const state = (name: string) => (name === MAIN ? "main agent" : host.state(name));

	const roster = () =>
		[
			"Members:",
			`- ${MAIN}: ${state(MAIN)}`,
			...active().map((member) => `- ${member.name}: ${state(member.name)} — ${member.description}`),
			`Topic: ${topic || "(none)"}`,
		].join("\n");

	/** The messages for `name` whose seq `seen`, the seqs its branch holds, lacks. */
	const due = (name: string, seen: Set<number>) => messages.filter((message) => message.notify.includes(name) && !seen.has(message.seq));
	const pendingCount = (name: string, seen: Set<number>) => due(name, seen).length + (notices.get(name)?.length ?? 0);

	/** A thread's latest activity for `viewer`, the key board history pages by: the highest seq in it that the viewer can see. */
	const activity = (root: MessageRecord, viewer: string) => (messages.findLast((message) => rootOf(message) === root && sees(viewer, message)) ?? root).seq;

	/**
	 * One line about the board posts after `cursor` that `name` did not write, was not notified of, and whose seq `seen` lacks, without its join announcement,
	 * by thread; empty when there are none.
	 */
	const digest = (name: string, cursor: number, seen: Set<number>) => {
		const unseen = messages.filter(
			(message) =>
				message.to === BOARD &&
				message.seq > cursor &&
				message.from !== name &&
				!message.notify.includes(name) &&
				!seen.has(message.seq) &&
				message.seq !== joined.get(name),
		);
		if (!unseen.length) return "";
		const threads = new Map<MessageRecord, MessageRecord[]>();
		for (const message of unseen) add(threads, rootOf(message), message);
		/** The unseen posts by thread, in the order of each thread's latest unseen post. */
		const all = [...threads].sort(([, a], [, b]) => a[a.length - 1].seq - b[b.length - 1].seq);
		const by = (posts: MessageRecord[]) => `(${posts.map((message) => `#${message.seq} ${message.from}`).join(", ")})`;
		const shown = all.slice(-DIGEST_THREADS).map(([root, posts]) => {
			if (posts[0] !== root) return `#${root.seq} "${root.title}": ${plural(posts.length, "new reply", "new replies")} ${by(posts)}`;
			const replies = posts.slice(1);
			return `#${root.seq} ${root.from}: ${root.title}${replies.length ? `, ${plural(replies.length, "reply", "replies")} ${by(replies)}` : ""}`;
		});
		const earlier = all.slice(0, -DIGEST_THREADS);
		// History before this key lists every earlier thread.
		const key = () => Math.max(...earlier.map(([root]) => activity(root, name))) + 1;
		const read = earlier.length ? `; +${earlier.length} earlier (team history before=${key()})` : " (team history)";
		const inThreads = all.length < unseen.length ? ` in ${plural(all.length, "thread", "threads")}` : "";
		return `[team] Board: ${plural(unseen.length, "new post", "new posts")}${inThreads} — ${shown.join("; ")}${read}.\n\n`;
	};

	/** The messages for `name` that `seen` lacks, at most INBOX_SIZE; with `cursor`, the member's board cursor, also the digest of the board posts after it that `seen` lacks. */
	const inbox = (name: string, seen: Set<number>, cursor?: number): Delivery[] => {
		const pending = due(name, seen);
		const shown = pending.slice(0, INBOX_SIZE);
		const more = pending.length - shown.length;
		if (shown.length) pulled.set(name, Math.max(pulled.get(name) ?? 0, shown[shown.length - 1].seq));
		const notes = notices.get(name) ?? [];
		notices.delete(name);
		return [
			...shown.map((message, i) => ({
				seq: message.seq,
				from: message.from,
				text:
					render(message, name) +
					(more && i === shown.length - 1 ? `(${more} more team messages for you are pending; they arrive after your next tool results or before your run ends.)\n\n` : ""),
			})),
			...[...notes, cursor === undefined ? "" : digest(name, cursor, seen)].filter(Boolean).map((text) => ({ seq: 0, from: BOARD, text })),
		];
	};

	const wake = (name: string, message: MessageRecord) => {
		wokeBy.set(name, message.seq);
		host.wake(name, message.from);
	};

	/** The direct messages to member `name` after its last inbox pull. */
	const unread = (name: string) => messages.filter((message) => message.to !== BOARD && message.to.includes(name) && message.seq > (pulled.get(name) ?? 0));

	type Block = "hop" | "abort";
	/** `<recipient>#<seq>` of each stuck message the main agent was told about; route and afterRun can both find one. */
	const toldMain = new Set<string>();
	// A message stuck in an inbox calls for the main agent's decision, so it arrives like a team message, once.
	const tellMain = (message: MessageRecord, name: string, block: Block) => {
		const key = `${name}#${message.seq}`;
		if (toldMain.has(key)) return;
		toldMain.add(key);
		const why = block === "hop" ? `${name} is stopped, and ${message.from}'s run cannot wake it` : `you stopped ${name} with abort, so ${message.from}'s message cannot wake it`;
		host.notify(
			TEAM_NOTICE,
			BOARD,
			`[team] #${message.seq} ${message.from} → ${name} is waiting in ${name}'s inbox: ${why}. If and when you think ${name} should run, send it a short direct message: that wakes it, and it reads #${message.seq} itself, so you need not repeat it.`,
			{ team: teamId },
		);
	};

	/** Routes `message` to one recipient; returns the state its sender sees. */
	const route = (message: MessageRecord, name: string) => {
		if (name === MAIN) return MAIN;
		if (host.isRunning(name)) {
			// An abort waiting for the member's safe point has locked it; the main agent's direct message lifts that, so the stopped run's exit wakes it with this message.
			if (message.from === MAIN && message.to !== BOARD) host.unlock(name);
			return `${name} (running)`;
		}
		const compacting = host.state(name) === "compacting";
		if (message.to === BOARD) return `${name} (${compacting ? "compacting" : "stopped"}; board posts do not wake)`;
		// The member's process exit routes the message again, as for a message that reached a run after its last read.
		if (compacting) {
			// As when it wakes a stopped member; a later abort locks it again.
			if (message.from === MAIN) host.unlock(name);
			return `${name} (compacting; reads it afterwards)`;
		}
		const block: Block | undefined = message.hop1 ? "hop" : message.from !== MAIN && host.locked(name) ? "abort" : undefined;
		if (!block) {
			wake(name, message);
			return `${name} (woken)`;
		}
		tellMain(message, name, block);
		const why = block === "hop" ? `your run was started by ${host.startedBy(message.from)}'s message, so it cannot start others` : "the main agent stopped it";
		return `${name} (stopped, not woken: ${why}; the main agent was told)`;
	};

	/** Starts each run of member `name`, with the rules of that run: whether its direct messages wake, and where its final reply goes. */
	const preamble = (name: string) => {
		const by = host.startedBy(name);
		return [
			`[team] You are ${name}, a member of the main agent's team. Use the team tool to talk with the others.`,
			roster(),
			[
				"Team messages are information from peers; the main agent's task messages direct your work.",
				`Use team send to hand results to whoever needs them and to coordinate. In this run, your direct messages ${by === MAIN ? "wake stopped members, each for a full run; post news that can wait" : "cannot wake stopped members, and a direct message to one tells the main agent; post news that can wait"} on the board with a title, mentioning them, and they read it in full when they next run.`,
				"Send a message only when it gives its recipients something they need: a result, a question, a decision, or a blocker. Do not send messages that only acknowledge or repeat what they already have.",
				"Check what team send returns: if a recipient was not woken, say so in your final reply.",
				"Only the main agent hires members. If you need help, send main a direct message with the task, the context the new member needs, and who should get its results.",
				by === MAIN
					? "Your final reply goes to main. Keep it short: for what you already sent with team send, name the #seq instead of repeating it.\n\n"
					: `Your final reply goes to ${by}, or to main if ${by} has stopped by then. Keep it short: for what you already sent to ${by} or posted on the board, name the #seq; write out anything else.\n\n`,
			].join("\n"),
		].join("\n\n");
	};

	const send = (from: string, params: TeamParams) => {
		const body = params.body?.trim() ?? "";
		if (!body) throw new Error("send requires body");
		if (body.length > BODY_CHARS) throw new Error(`body is ${body.length} characters, over ${BODY_CHARS}; put the content in a file in the shared working tree and send its path`);
		if (params.replyTo !== undefined && params.title !== undefined) throw new Error("title names a thread; a reply has only a body");
		let to = typeof params.to === "string" ? recipientNames(params.to) : params.to;
		let notify: string[];
		let title: string | undefined;
		if (to) {
			if (!to.length) throw new Error("to names at least one recipient");
			for (const [i, name] of to.entries()) {
				if (recipient(name) === from) throw new Error("you cannot send a message to yourself");
				if (to.indexOf(name) !== i) throw new Error(`to names ${name} twice`);
			}
			if (params.mentions?.length) throw new Error("mentions apply to board posts; a direct message notifies its recipients");
			if (params.title !== undefined) throw new Error("title applies to board posts; a direct message has only a body");
			notify = [...to];
		} else {
			// A reply joins its thread, which the title of its first post names.
			title = params.replyTo === undefined ? (params.title?.trim() ?? "") : undefined;
			if (title === "") throw new Error(`a board post requires title: one line of at most ${TITLE_CHARS} characters`);
			if (title && /[\r\n\u2028\u2029]/.test(title)) throw new Error(`title must be one line of at most ${TITLE_CHARS} characters`);
			if (title && title.length > TITLE_CHARS) throw new Error(`title is ${title.length} characters, over ${TITLE_CHARS}; put the details in the body`);
			notify = (params.mentions ?? []).filter((name) => name !== "all").map(recipient);
			if (params.mentions?.includes("all")) {
				if (from !== MAIN) throw new Error("only the main agent can mention all");
				notify = active().map((member) => member.name);
			}
		}
		if (params.replyTo !== undefined) {
			const target = messages.find((message) => message.seq === params.replyTo);
			if (!(target && visibleTo(target, from))) throw new Error(unseen(params.replyTo));
			if (!to && target.to !== BOARD) throw new Error(`#${params.replyTo} is a direct message; a board post replies only to a board post, so answer it with to`);
			// A direct reply also goes to the author of the message it answers, so `to` holds every recipient; a retired author gets neither.
			if (!retired.has(target.from)) {
				notify.push(target.from);
				if (to && target.from !== from && !to.includes(target.from)) to = [...to, target.from];
			}
		}
		notify = [...new Set(notify)].filter((name) => name !== from);
		const message: MessageRecord = {
			t: "msg",
			seq: (messages.at(-1)?.seq ?? 0) + 1,
			at: Date.now(),
			from,
			to: to ?? BOARD,
			...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
			...(params.mentions?.length ? { mentions: params.mentions } : {}),
			notify,
			...(title ? { title } : {}),
			body,
			...(host.startedBy(from) !== MAIN ? { hop1: true as const } : {}),
		};
		append(message);
		track(message);
		for (const name of notify) ping(name);
		if (notify.includes(MAIN)) host.notify(TEAM_MESSAGE, from, render(message, MAIN), details(message));
		if (!notify.length) return `Posted #${message.seq}. It notified nobody; members see it in history.`;
		return `Sent #${message.seq} to ${notify.map((name) => route(message, name)).join(", ")}.`;
	};

	/** Lists history `items`, ascending by key, in the caller's order within the limit and the character budget, dropping from the far end, and names the call that reads on. */
	const page = (items: { key: number; text: string; covered: number[] }[], params: TeamParams) => {
		const newest = params.order !== "oldest";
		let shown = (newest ? [...items].reverse() : items).slice(0, Math.min(params.limit ?? HISTORY_LIMIT, MAX_HISTORY_LIMIT));
		while (shown.length > 1 && shown.reduce((sum, item) => sum + item.text.length, 0) > HISTORY_CHARS) shown = shown.slice(0, -1);
		const covered = shown.flatMap((item) => item.covered);
		if (!shown.length) return { text: "No messages.", covered };
		const far = shown[shown.length - 1].key;
		const more = items.length > shown.length ? (newest ? `More: history before=${far}.` : `More: history order=oldest after=${far}.`) : "";
		return { text: (shown.map((item) => item.text).join("") + more).trimEnd(), covered };
	};

	/** The board as threads by latest activity, each its first post and a count of its replies, or the caller's direct messages `with` a member, or one thread. */
	const history = (caller: string, params: TeamParams) => {
		if (params.thread !== undefined) return thread(caller, params);
		if (params.with !== undefined && known(params.with) === caller) throw new Error("with names another member");
		const query = params.query ? normalize(params.query) : "";
		const matches = (message: MessageRecord) => !query || normalize(`${message.title ?? ""}\n${message.body}`).includes(query);
		const inRange = (key: number) => (params.before === undefined || key < params.before) && (params.after === undefined || key > params.after);
		if (params.with !== undefined) {
			const found = messages.filter(
				(message) =>
					participants(message).includes(params.with as string) &&
					// The main agent reads every direct message of the member, with any counterpart.
					(caller === MAIN || participants(message).includes(caller)) &&
					inRange(message.seq) &&
					matches(message),
			);
			return page(found.map((message) => ({ key: message.seq, text: render(message, caller), covered: [message.seq] })), params);
		}
		const threads = new Map<MessageRecord, MessageRecord[]>();
		for (const message of messages) {
			if (rootOf(message).to === BOARD && sees(caller, message)) add(threads, rootOf(message), message);
		}
		const items = [...threads].flatMap(([root, posts]) => {
			const key = posts[posts.length - 1].seq;
			const found = posts.filter(matches);
			if (!inRange(key) || !found.length) return [];
			const replies = found.filter((message) => message !== root);
			const lines = [
				posts.length > 1 ? `\n${plural(posts.length - 1, "reply", "replies")}, latest #${key}` : "",
				query && replies.length ? `\nmatches ${replies.map((message) => `#${message.seq}`).join(", ")}` : "",
			];
			return [{ key, text: `${render(root, caller).trimEnd()}${lines.join("")}\n\n`, covered: [root.seq] }];
		});
		return page(items.sort((a, b) => a.key - b.key), params);
	};

	/**
	 * The thread of message `params.thread` from its highest ancestor the caller can see, as a tree of the messages it can see.
	 * Pages select messages by seq, then show them in tree order; `after` is the highest seq on the page, not its last tree node.
	 */
	const thread = (caller: string, params: TeamParams) => {
		if ([params.with, params.query, params.before].some((value) => value !== undefined)) throw new Error("thread takes no with, query, or before; use after to continue");
		const target = messages.find((message) => message.seq === params.thread);
		if (!(target && sees(caller, target))) throw new Error(unseen(params.thread as number));
		const all = messages.filter((message) => rootOf(message) === rootOf(target));
		const bySeq = new Map(all.map((message) => [message.seq, message]));
		const up = (message: MessageRecord) => bySeq.get(message.replyTo ?? 0);
		let top = target;
		for (let parent = up(target); parent; parent = up(parent)) if (sees(caller, parent)) top = parent;
		// A message hangs under its nearest ancestor the caller can see.
		const children = new Map<MessageRecord, MessageRecord[]>();
		for (const message of all) {
			if (!sees(caller, message)) continue;
			let parent = up(message);
			while (parent && !sees(caller, parent)) parent = up(parent);
			if (parent) add(children, parent, message);
		}
		const nodes: { message: MessageRecord; depth: number }[] = [];
		const stack = [{ message: top, depth: 0 }];
		while (stack.length) {
			const node = stack.pop()!;
			nodes.push(node);
			for (const child of [...(children.get(node.message) ?? [])].reverse()) stack.push({ message: child, depth: node.depth + 1 });
		}
		const header = `Thread #${top.seq}${top.title ? ` "${top.title}"` : ""} · ${plural(nodes.length, "message", "messages")}\n\n`;
		const more = (seq: number) => `More: history thread=${target.seq} after=${seq}.`;
		const budget = HISTORY_CHARS - header.length - more(lastSeq()).length - 2;
		const remaining = nodes.filter(({ message }) => message.seq > (params.after ?? 0)).sort((a, b) => a.message.seq - b.message.seq);
		const shown = new Map<number, string>();
		let total = 0;
		for (const { message, depth } of remaining.slice(0, params.limit ?? MAX_HISTORY_LIMIT)) {
			let flat = render(message, caller);
			// An unusually large recipient list may shorten the routing line, never the message body.
			if (flat.length > budget) flat = `${flat.slice(0, budget - message.body.length - 4)}…\n${message.body}\n\n`;
			let text = flat.replace(/^(?=.)/gm, "  ".repeat(Math.min(depth, 8)));
			if (text.length > budget) text = flat;
			if (total + text.length > budget) break;
			shown.set(message.seq, text);
			total += text.length;
		}
		const covered = nodes.map(({ message }) => message.seq).filter((seq) => shown.has(seq));
		if (!covered.length) return { text: "No messages.", covered };
		const next = shown.size < remaining.length ? more(Math.max(...shown.keys())) : "";
		return { text: (header + covered.map((seq) => shown.get(seq)).join("") + next).trimEnd(), covered };
	};

	const setTopic = (caller: string, params: TeamParams) => {
		if (caller !== MAIN) throw new Error("only the main agent sets the topic");
		const body = params.body?.trim() ?? "";
		if (!body) throw new Error("topic requires body, which holds the topic text");
		if (body.length > TOPIC_CHARS) throw new Error(`topic is ${body.length} characters, over ${TOPIC_CHARS}; put the details in a file and name it in the topic`);
		append({ t: "topic", at: Date.now(), body });
		topic = body;
		return "Topic set.";
	};

	/** Every action except wait, which callers handle themselves. History also returns `covered`, the seqs it showed. */
	const act = (caller: string, params: TeamParams): { text: string; covered?: number[] } => {
		if (params.action === "send") return { text: send(caller, params) };
		if (params.action === "history") return history(caller, params);
		if (params.action === "members") return { text: roster() };
		if (params.action === "topic") return { text: setTopic(caller, params) };
		throw new Error(`unknown team action: ${params.action}`);
	};

	/** Holds a member's `wait` until a message for it is pending, the main agent asks to stop, compact, or switch it, `ms` pass, or its run ends. */
	const wait = (name: string, seen: Set<number>, ms: number, signal: AbortSignal) =>
		new Promise<number>((done) => {
			if (pendingCount(name, seen) || host.interrupted(name) || ms <= 0 || signal.aborted) return done(pendingCount(name, seen));
			const held = waiters.get(name) ?? new Set();
			waiters.set(name, held);
			const end = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", end);
				held.delete(end);
				done(pendingCount(name, seen));
			};
			const timer = setTimeout(end, ms);
			signal.addEventListener("abort", end, { once: true });
			held.add(end);
		});

	pi.registerTool({
		name: "team",
		label: "Team",
		description: TEAM_DESCRIPTION,
		parameters: teamParameters,
		async execute(_toolCallId, params, signal) {
			if (params.action !== "wait") {
				const { text: result, covered } = act(MAIN, params);
				// The branch has seen the message it sent, or the messages it showed; an entry of its own, since a call made through
				// another tool, such as codemode, returns no details.
				if (params.action === "send") pi.appendEntry(SEEN_ENTRY, { team: teamId, seq: lastSeq() });
				else if (covered?.length) pi.appendEntry(SEEN_ENTRY, { team: teamId, covered });
				return text(result);
			}
			const ms = Math.min(params.ms ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
			const count = await host.waitForMain(ms, signal);
			return text(count ? `${count} message(s) for you follow this result.` : `No messages for you within ${ms}ms.${host.footer(MAIN)}`);
		},
	});

	/** Appends to the main agent's current branch without starting a turn. */
	const quietly = (customType: string, content: string, details: object) => pi.sendMessage({ customType, content, display: true, details }, { triggerTurn: false });

	return {
		/**
		 * Loads the team of the session at `base` (its file path without .jsonl) and returns its members.
		 * A missing log means a new team, with a new id and no members yet.
		 */
		load(base: string, ctx: ExtensionContext): MemberRecord[] {
			log = join(base, "team.jsonl");
			if (!existsSync(log)) {
				teamId = randomUUID();
				return [];
			}
			const content = readFileSync(log, "utf8");
			// An interrupted write leaves a partial last line; end it so the next record starts a line of its own.
			if (content && !content.endsWith("\n")) appendFileSync(log, "\n");
			/** The member whose record the previous line holds. */
			let hired: string | undefined;
			content
				.split("\n")
				.forEach((line, i) => {
					if (!line.trim()) return;
					let record: any;
					try {
						record = JSON.parse(line);
					} catch {}
					const joiner = hired;
					hired = undefined;
					if (record?.t === "member" && typeof record.name === "string" && typeof record.description === "string" && Array.isArray(record.args)) {
						// A member's later record, such as one a switch writes, replaces its earlier one.
						members.set(record.name, record);
						hired = record.name;
					} else if (record?.t === "msg" && typeof record.seq === "number" && Array.isArray(record.notify) && (record.to === BOARD || Array.isArray(record.to))) {
						track(record);
						if (joiner && record.from === MAIN && record.to === BOARD && String(record.title).startsWith(`joined: ${joiner} — `)) joined.set(joiner, record.seq);
					} else if (record?.t === "topic" && typeof record.body === "string") topic = record.body;
					else if (record?.t === "retire" && typeof record.name === "string") retired.add(record.name);
					else if (record?.t === "team" && typeof record.id === "string") teamId ||= record.id;
					else if (ctx.hasUI) ctx.ui.notify(`team.jsonl line ${i + 1} is not a team record; skipped`, "warning");
				});
			for (const name of members.keys()) pulled.set(name, lastSeq());
			// A log without an id gets one, which every later load reads.
			if (!teamId) {
				teamId = randomUUID();
				appendFileSync(log, jsonLine({ t: "team", id: teamId }));
			}
			return [...members.values()];
		},

		/**
		 * Appends to the main agent's current branch the messages to or from it that `shown`, the details of that branch and of the messages
		 * waiting for it, do not mark seen. The latest arrive in full. One notice counts the earlier ones and those that `summarized`, the details
		 * of the entries a new branch summary covers, mark seen; its `covered` marks them seen on this branch.
		 */
		redeliver(shown: Details[], summarized: Details[] = []) {
			const seen = seenIn(shown, teamId);
			const inSummaryOf = seenIn(summarized, teamId);
			const missing = messages.filter((message) => (message.from === MAIN || message.notify.includes(MAIN)) && !seen.has(message.seq));
			const inSummary = missing.filter((message) => inSummaryOf.has(message.seq));
			const rest = missing.filter((message) => !inSummaryOf.has(message.seq));
			const earlier = rest.slice(0, Math.max(0, rest.length - INBOX_SIZE));
			const count = (list: MessageRecord[]) =>
				list.length === 1 ? `1 team message to or from you (#${list[0].seq})` : `${list.length} team messages to or from you (#${list[0].seq} to #${list[list.length - 1].seq})`;
			const read = "read them with team history (with: a member, for direct messages; thread: a #seq, for a thread)";
			const notice = [
				earlier.length ? `[team] Not shown here: ${count(earlier)}, earlier than those below; ${read}.\n\n` : "",
				inSummary.length ? `[team] The branch summary covers ${count(inSummary)}; ${read}.\n\n` : "",
			].join("");
			if (notice) quietly(TEAM_NOTICE, notice, { team: teamId, covered: [...earlier, ...inSummary].map((message) => message.seq) });
			for (const message of rest.slice(earlier.length)) quietly(TEAM_MESSAGE, render(message, MAIN), details(message));
		},

		/** In a forked session whose branch, with details `shown`, holds another team's messages, tells the main agent whose they are. */
		forked(shown: Details[]) {
			if (shown.some((details) => typeof details?.team === "string" && details.team !== teamId)) quietly(TEAM_NOTICE, FORK_NOTICE, { team: teamId });
		},

		/** Validates a new member's name and description, records it, and announces it on the board; returns the details that mark the announcement seen. */
		hire(name: string, description: string, cwd: string, args: string[]) {
			if (!NAME.test(name)) throw new Error(`name must match ${NAME.source}`);
			if (RESERVED.has(name)) throw new Error(`${name} is reserved`);
			if (retired.has(name)) throw new Error(`${name} is retired; a retired member's name is not reused`);
			if (members.has(name)) throw new Error(`${name} is already a member; send it a direct message with team send`);
			const role = description.trim();
			if (!role) throw new Error("run requires description: the member's lasting role, in one line");
			if (/[\r\n\u2028\u2029]/.test(role)) throw new Error(`description must be one line of at most ${DESCRIPTION_CHARS} characters`);
			if (role.length > DESCRIPTION_CHARS) throw new Error(`description is ${role.length} characters, over ${DESCRIPTION_CHARS}; name the member's lasting role in one line`);
			const member: MemberRecord = { t: "member", name, description: role, cwd, args };
			// A board post that notifies no one; one write with the member record, so a failed write leaves neither.
			const title = `joined: ${name} — ${role}`;
			const post: MessageRecord = { t: "msg", seq: lastSeq() + 1, at: Date.now(), from: MAIN, to: BOARD, notify: [], title, body: title };
			append(member, post);
			members.set(name, member);
			track(post);
			joined.set(name, post.seq);
			return details(post);
		},

		/** Whether the main agent retired member `name`. */
		isRetired: (name: string) => retired.has(name),

		/** Ends member `name`'s wait, so it reaches its next safe point, where the main agent's stop, compaction, or switch applies. */
		interrupt: ping,

		/** Retires member `name`: it leaves the roster, messages cannot name it, and nothing wakes it again; throws when the log write fails. */
		retire(name: string) {
			append({ t: "retire", name });
			retired.add(name);
		},

		/** The seqs of the direct messages to member `name` after its last inbox pull. */
		unread: (name: string) => unread(name).map((message) => message.seq),

		/** Records new launch args for member `name`, such as another model; throws when the log write fails. */
		relaunch(name: string, args: string[]) {
			const member: MemberRecord = { ...(members.get(name) as MemberRecord), args };
			append(member);
			members.set(name, member);
		},

		/**
		 * The main agent's board digest of the posts after the board cursor of `entries`, its current branch, that the branch does not hold,
		 * as a notice entry, or undefined when there is nothing new. Once on the branch, the entry moves that cursor.
		 */
		mainDigest(entries: SessionEntry[]) {
			const content = digest(MAIN, boardCursor(entries, teamId), seenIn(entries.map(detailsOf), teamId));
			return content ? { type: "custom_message" as const, customType: TEAM_NOTICE, content, display: true, details: { team: teamId, board: lastSeq() } } : undefined;
		},

		/** Sends a woken member's final reply to the running member that woke it; returns the message's seq. */
		reply(from: string, to: string, body: string) {
			send(from, { action: "send", to, body });
			return lastSeq();
		},

		/**
		 * Once a member's run is over, routes again the direct messages that reached it after its last inbox pull:
		 * one from a sender that can wake it starts its next run; the others wait, and their senders and the main agent are told.
		 */
		afterRun(name: string) {
			// The main agent learned of a retired member's unread messages from its retirement.
			if (retired.has(name)) return;
			const left = unread(name);
			if (!left.length) return;
			// A member the main agent aborted stays stopped; only the main agent hears about its unread messages.
			const locked = host.locked(name);
			// The waking message and those before it never wake the member again; their senders learn the outcome from its result.
			const eligible = (message: MessageRecord) => !message.hop1 && message.seq > (wokeBy.get(name) ?? 0);
			// The main agent's message comes first, so a run it restarts reports to it and may wake others.
			const waker = locked ? undefined : (left.find((message) => message.from === MAIN && eligible(message)) ?? left.find(eligible));
			if (waker) return wake(name, waker);
			for (const message of left) {
				if (message.from === MAIN || !(locked || message.hop1)) continue;
				tellMain(message, name, locked ? "abort" : "hop");
				if (locked || !host.isRunning(message.from)) continue;
				tell(
					message.from,
					`[team] #${message.seq} to ${name} was not delivered: ${name} stopped before reading it, and your run cannot wake it. It waits in ${name}'s inbox; the main agent was told.\n\n`,
				);
			}
		},

		/** Tells each running member other than `except` that sent `name` a direct message at or after `since` that `name` stopped on an error. */
		stoppedOnError(name: string, since: number, except: string) {
			const senders = new Set(messages.filter((message) => message.to !== BOARD && message.to.includes(name) && message.at >= since).map((message) => message.from));
			for (const sender of senders) {
				if (sender !== MAIN && sender !== except && host.isRunning(sender)) tell(sender, `[team] ${name} stopped on an error; the main agent was told.\n\n`);
			}
		},

		/** Answers a member's request. */
		async answer(name: string, request: Request, signal: AbortSignal): Promise<Reply> {
			const seen = new Set("seen" in request && Array.isArray(request.seen) ? request.seen.filter(Number.isInteger) : []);
			try {
				if (request.op === "start") return { ok: true, team: teamId, preamble: preamble(name) };
				if (request.op === "inbox") {
					if (typeof request.board !== "number") return { ok: true, messages: inbox(name, seen) };
					return { ok: true, messages: inbox(name, seen, request.board), board: lastSeq() };
				}
				if (request.op === "wait") {
					const ms = Math.min(Number(request.ms) || 0, MAX_WAIT_MS);
					const count = await wait(name, seen, ms, signal);
					if (count) return { ok: true, text: `${count} team message(s) for you follow this result.` };
					if (host.interrupted(name)) return { ok: true, text: "Returned early: the main agent stops, compacts, or switches your run once this tool call ends." };
					return { ok: true, text: `No team messages for you within ${ms}ms.${host.footer(name)}` };
				}
				if (request.op === "team" && request.action !== "wait") return { ok: true, ...act(name, request) };
				return { error: `unsupported request: ${request.op}` };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

export type Team = ReturnType<typeof createTeam>;
