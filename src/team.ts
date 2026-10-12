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
	seenIn,
	TEAM_DESCRIPTION,
	TEAM_MESSAGE,
	TOPIC_CHARS,
	type TeamParams,
	teamParameters,
} from "./protocol.ts";

const MAIN = "main";
const BOARD = "team";
/** Custom message type of the one-line notices that tell the main agent about a message no one could wake for. */
const TEAM_NOTICE = "team-notice";
const NAME = /^[a-z][a-z0-9-]{0,22}[a-z0-9]$/;
// `team` marks the board in the log's `to` field.
const RESERVED = new Set([MAIN, "all", BOARD]);
const INBOX_SIZE = 10;
const HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 50;
const HISTORY_CHARS = 16_000;
const DIGEST_POSTS = 3;
const DIGEST_CHARS = 80;
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
	to: string;
	replyTo?: number;
	mentions?: string[];
	notify: string[];
	body: string;
	/** The sender's run was started by a member's message, so the message cannot wake anyone. */
	hop1?: true;
}
interface TopicRecord {
	t: "topic";
	at: number;
	body: string;
}

export interface TeamHost {
	isRunning(name: string): boolean;
	/** Who started the member's current or last run: main, or the member whose message woke it. Main itself: main. */
	startedBy(name: string): string;
	/** The main agent aborted the member, so only its direct message wakes it. */
	locked(name: string): boolean;
	/** Starts a stopped member's next run for a direct message from `by`. */
	wake(name: string, by: string): void;
	/** Delivers a message to the main agent. */
	notify(customType: string, from: string, text: string, details: object): void;
	/** Tells the main agent something without starting a turn. */
	notice(customType: string, text: string, details: object): void;
	/** Resolves with the number of messages pending for the main agent once there is one, or after `ms`. */
	waitForMain(ms: number, signal?: AbortSignal): Promise<number>;
}

const jsonLine = (record: object) => `${JSON.stringify(record)}\n`;
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
const text = (body: string, details?: object) => ({ content: [{ type: "text" as const, text: body }], details });

const visibleTo = (message: MessageRecord, name: string) => message.to === BOARD || message.from === name || message.to === name;

/** One message as its viewer reads it. Ends with a blank line, which keeps consecutive messages apart. */
function render(message: MessageRecord, viewer: string) {
	const who = (name: string) => (name === viewer ? "you" : name);
	const route = message.to === BOARD ? `${who(message.from)} → #team` : `${who(message.from)} → ${who(message.to)} (direct)`;
	const reply = message.replyTo ? `, replying to #${message.replyTo}` : "";
	const mentions = message.mentions?.length ? `, mentions ${message.mentions.map(who).join(", ")}` : "";
	return `[team #${message.seq}] ${route}${reply}${mentions}:\n${message.body}\n\n`;
}

export function createTeam(pi: ExtensionAPI, host: TeamHost) {
	/** `<session base>/team.jsonl`, created by the first record written to it. */
	let log = "";
	/** The team's id, the first record of its log; session entries about the team carry it in their details. */
	let teamId = "";
	const members = new Map<string, MemberRecord>();
	let messages: MessageRecord[] = [];
	let topic = "";
	/** Held `wait` requests by member. */
	const waiters = new Map<string, Set<() => void>>();
	// shortcut: pull marks and sender notices live in memory; reopening a session forgets them, and every member is stopped then anyway.
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

	const append = (...records: (MemberRecord | MessageRecord | TopicRecord)[]) => {
		// The first write creates the log, which starts with the team's id.
		const id = existsSync(log) ? "" : jsonLine({ t: "team", id: teamId });
		mkdirSync(dirname(log), { recursive: true });
		appendFileSync(log, id + records.map(jsonLine).join(""));
	};
	const details = (message: MessageRecord) => ({ team: teamId, seq: message.seq, from: message.from });

	const known = (name: string) => {
		if (name !== MAIN && !members.has(name)) throw new Error(`Unknown member: ${name}. Members: ${[MAIN, ...members.keys()].join(", ")}`);
		return name;
	};

	const state = (name: string) => (name === MAIN ? "main agent" : host.isRunning(name) ? "running" : "stopped");

	const roster = () =>
		[
			"Members:",
			`- ${MAIN}: ${state(MAIN)}`,
			...[...members.values()].map((member) => `- ${member.name}: ${state(member.name)} — ${member.description}`),
			`Topic: ${topic || "(none)"}`,
		].join("\n");

	/** The messages for `name` whose seq `seen`, the seqs its branch holds, lacks. */
	const due = (name: string, seen: Set<number>) => messages.filter((message) => message.notify.includes(name) && !seen.has(message.seq));
	const pendingCount = (name: string, seen: Set<number>) => due(name, seen).length + (notices.get(name)?.length ?? 0);

	/** One line about the board posts after `cursor` that `name` did not write, was not notified of, and whose seq `seen` lacks, without its join announcement; empty when there are none. */
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
		const cut = (body: string) => {
			const flat = body.replace(/\s+/g, " ").trim();
			return flat.length > DIGEST_CHARS ? `${flat.slice(0, DIGEST_CHARS)}…` : flat;
		};
		const latest = unseen.slice(-DIGEST_POSTS);
		const shown = latest.map((message) => `#${message.seq} ${message.from}: ${cut(message.body)}`);
		const more = unseen.length - latest.length;
		const read = more ? `; +${more} earlier (team history before=${latest[0].seq})` : " (team history)";
		return `[team] Board: ${unseen.length} new post${unseen.length === 1 ? "" : "s"} — ${shown.join("; ")}${read}.\n\n`;
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

	type Block = "hop" | "abort";
	const tellMain = (message: MessageRecord, name: string, block: Block) => {
		const why = block === "hop" ? `${name} is stopped, and ${message.from}'s run cannot wake it` : `you stopped ${name} with abort, so ${message.from}'s message cannot wake it`;
		host.notice(
			TEAM_NOTICE,
			`[team] #${message.seq} ${message.from} → ${name} is waiting in ${name}'s inbox: ${why}. A direct message from you would wake ${name}, if and when you think it should run.`,
			{ team: teamId },
		);
	};

	/** Routes `message` to one recipient; returns the state its sender sees. */
	const route = (message: MessageRecord, name: string) => {
		if (name === MAIN) return MAIN;
		if (host.isRunning(name)) return `${name} (running)`;
		if (message.to === BOARD) return `${name} (stopped; board posts do not wake)`;
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
				`Use team send to hand results to whoever needs them and to coordinate. In this run, your direct messages ${by === MAIN ? "wake" : "cannot wake"} stopped members.`,
				"Check what team send returns: if a recipient was not woken, say so in your final reply.",
				"Only the main agent hires members. If you need help, send main a direct message with the task, the context the new member needs, and who should get its results.",
				`Your final reply goes to ${by === MAIN ? MAIN : `${by}, or to main if ${by} has stopped by then`}. Keep it short: for what you already sent with team send, name the #seq instead of repeating it.\n\n`,
			].join("\n"),
		].join("\n\n");
	};

	const send = (from: string, params: TeamParams) => {
		const body = params.body?.trim() ?? "";
		if (!body) throw new Error("send requires body");
		if (body.length > BODY_CHARS) throw new Error(`body exceeds ${BODY_CHARS} characters; put the content in a file in the shared working tree and send its path`);
		let notify: string[];
		if (params.to !== undefined) {
			if (known(params.to) === from) throw new Error("you cannot send a message to yourself");
			if (params.mentions?.length) throw new Error("mentions apply to board posts; a direct message notifies its recipient");
			notify = [params.to];
		} else {
			notify = (params.mentions ?? []).filter((name) => name !== "all").map(known);
			if (params.mentions?.includes("all")) {
				if (from !== MAIN) throw new Error("only the main agent can mention all");
				notify = [...members.keys()];
			}
		}
		if (params.replyTo !== undefined) {
			const target = messages.find((message) => message.seq === params.replyTo);
			const sameScope =
				target &&
				visibleTo(target, from) &&
				(params.to === undefined ? target.to === BOARD : target.to !== BOARD && (target.from === params.to || target.to === params.to));
			if (!sameScope) throw new Error(`#${params.replyTo} is not a message in this ${params.to === undefined ? "board" : "conversation"} that you can see`);
			notify.push(target.from);
		}
		notify = [...new Set(notify)].filter((name) => name !== from);
		const message: MessageRecord = {
			t: "msg",
			seq: (messages.at(-1)?.seq ?? 0) + 1,
			at: Date.now(),
			from,
			to: params.to ?? BOARD,
			...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
			...(params.mentions?.length ? { mentions: params.mentions } : {}),
			notify,
			body,
			...(host.startedBy(from) !== MAIN ? { hop1: true as const } : {}),
		};
		append(message);
		messages.push(message);
		for (const name of notify) ping(name);
		if (notify.includes(MAIN)) host.notify(TEAM_MESSAGE, from, render(message, MAIN), details(message));
		if (!notify.length) return `Posted #${message.seq}. It notified nobody; members see it in history.`;
		return `Sent #${message.seq} to ${notify.map((name) => route(message, name)).join(", ")}.`;
	};

	const history = (caller: string, params: TeamParams) => {
		if (params.with !== undefined && known(params.with) === caller) throw new Error("with names another member");
		const limit = Math.min(params.limit ?? HISTORY_LIMIT, MAX_HISTORY_LIMIT);
		const query = params.query ? normalize(params.query) : "";
		const found = messages.filter(
			(message) =>
				(params.with === undefined
					? message.to === BOARD
					: (message.from === caller && message.to === params.with) || (message.from === params.with && message.to === caller)) &&
				(params.before === undefined || message.seq < params.before) &&
				(!query || normalize(message.body).includes(query)),
		);
		let shown = found.slice(-limit).map((message) => ({ seq: message.seq, text: render(message, caller) }));
		while (shown.length > 1 && shown.reduce((sum, message) => sum + message.text.length, 0) > HISTORY_CHARS) shown = shown.slice(1);
		const covered = shown.map((message) => message.seq);
		if (!shown.length) return { text: "No messages.", covered };
		const older = found.length > shown.length ? `Older messages exist: history before=${shown[0].seq}.\n\n` : "";
		return { text: older + shown.map((message) => message.text).join("").trimEnd(), covered };
	};

	const setTopic = (caller: string, params: TeamParams) => {
		if (caller !== MAIN) throw new Error("only the main agent sets the topic");
		const body = params.body?.trim() ?? "";
		if (!body) throw new Error("topic requires body");
		if (body.length > TOPIC_CHARS) throw new Error(`topic exceeds ${TOPIC_CHARS} characters; put the details in a file and name it in the topic`);
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

	/** Holds a member's `wait` until a message for it is pending, `ms` pass, or its run ends. */
	const wait = (name: string, seen: Set<number>, ms: number, signal: AbortSignal) =>
		new Promise<number>((done) => {
			if (pendingCount(name, seen) || ms <= 0 || signal.aborted) return done(pendingCount(name, seen));
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
				// The branch holding this result has seen the message it sent, or the messages it showed.
				if (params.action === "send") return text(result, { team: teamId, seq: lastSeq() });
				return text(result, covered ? { team: teamId, covered } : undefined);
			}
			const ms = Math.min(params.ms ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
			const count = await host.waitForMain(ms, signal);
			return text(count ? `${count} message(s) for you follow this result.` : `No messages for you within ${ms}ms.`);
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
						members.set(record.name, record);
						hired = record.name;
					} else if (record?.t === "msg" && typeof record.seq === "number" && Array.isArray(record.notify)) {
						messages.push(record);
						if (joiner && record.from === MAIN && record.to === BOARD && String(record.body).startsWith(`joined: ${joiner} — `)) joined.set(joiner, record.seq);
					} else if (record?.t === "topic" && typeof record.body === "string") topic = record.body;
					else if (record?.t === "team" && typeof record.id === "string") teamId ||= record.id;
					else if (ctx.hasUI) ctx.ui.notify(`team.jsonl line ${i + 1} is not a team record; skipped`, "warning");
				});
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
			const read = "read them in full with team history (with: a member, for direct messages)";
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
			if (members.has(name)) throw new Error(`${name} is already a member; send it a direct message with team send`);
			const role = description.trim();
			if (!role) throw new Error("run requires description: the member's lasting role, in one line");
			if (role.length > DESCRIPTION_CHARS || /[\r\n\u2028\u2029]/.test(role)) throw new Error(`description must be one line of at most ${DESCRIPTION_CHARS} characters`);
			const member: MemberRecord = { t: "member", name, description: role, cwd, args };
			// A board post that notifies no one; one write with the member record, so a failed write leaves neither.
			const post: MessageRecord = { t: "msg", seq: lastSeq() + 1, at: Date.now(), from: MAIN, to: BOARD, notify: [], body: `joined: ${name} — ${role}` };
			append(member, post);
			members.set(name, member);
			messages.push(post);
			joined.set(name, post.seq);
			return details(post);
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
			const unread = messages.filter((message) => message.to === name && message.seq > (pulled.get(name) ?? 0));
			if (!unread.length) return;
			// A member the main agent aborted stays stopped; only the main agent hears about its unread messages.
			const locked = host.locked(name);
			// The waking message and those before it never wake the member again; their senders learn the outcome from its result.
			const waker = locked ? undefined : unread.find((message) => !message.hop1 && message.seq > (wokeBy.get(name) ?? 0));
			if (waker) return wake(name, waker);
			for (const message of unread) {
				if (message.from === MAIN || !(locked || message.hop1)) continue;
				tellMain(message, name, locked ? "abort" : "hop");
				if (locked || !host.isRunning(message.from)) continue;
				notices.set(message.from, [
					...(notices.get(message.from) ?? []),
					`[team] #${message.seq} to ${name} was not delivered: ${name} stopped before reading it, and your run cannot wake it. It waits in ${name}'s inbox; the main agent was told.\n\n`,
				]);
				ping(message.from);
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
				if (request.op === "wait") return { ok: true, count: await wait(name, seen, Math.min(Number(request.ms) || 0, MAX_WAIT_MS), signal) };
				if (request.op === "team" && request.action !== "wait") return { ok: true, ...act(name, request) };
				return { error: `unsupported request: ${request.op}` };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

export type Team = ReturnType<typeof createTeam>;
