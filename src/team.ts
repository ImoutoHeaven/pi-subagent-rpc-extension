/**
 * Team state: the log, routing, history, the main agent's `team` tool, and answers to members' requests.
 * It has no path to a process: it asks the host about members' runs, wakes members through it, and hands it messages for the main agent.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BODY_CHARS,
	DEFAULT_WAIT_MS,
	type Delivery,
	MAX_WAIT_MS,
	type Reply,
	type Request,
	TEAM_DESCRIPTION,
	TEAM_MESSAGE,
	TOPIC_CHARS,
	type TeamParams,
	teamCursor,
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

const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
const text = (body: string) => ({ content: [{ type: "text" as const, text: body }], details: undefined });

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
	/** The id of the session that owns the team. */
	let teamId = "";
	const members = new Map<string, MemberRecord>();
	let messages: MessageRecord[] = [];
	let topic = "";
	/** Held `wait` requests by member. */
	const waiters = new Map<string, Set<() => void>>();
	// shortcut: inbox and board cursors and sender notices live in memory; reopening a session forgets them, and every member is stopped then anyway.
	/** Per member, the highest seq its inbox returned. */
	const seen = new Map<string, number>();
	/** Per agent, the seq up to which it has seen the board, in full, in a digest, or in history. */
	const boardSeen = new Map<string, number>();
	/** Per member, the seq of the message that woke its current or last run; it never wakes the member again. */
	const wokeBy = new Map<string, number>();
	/** Notices for running senders about messages their recipient never read; not log records. */
	const notices = new Map<string, string[]>();
	const lastSeq = () => messages.at(-1)?.seq ?? 0;
	const ping = (name: string) => {
		for (const wake of [...(waiters.get(name) ?? [])]) wake();
	};

	const append = (...records: (MemberRecord | MessageRecord | TopicRecord)[]) => {
		mkdirSync(dirname(log), { recursive: true });
		appendFileSync(log, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
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

	const due = (name: string, after: number) => messages.filter((message) => message.seq > after && message.notify.includes(name));
	const pendingCount = (name: string, after: number) => due(name, after).length + (notices.get(name)?.length ?? 0);

	/** One line about the board posts `name` has not seen and was not notified of; empty when there are none. Marks them seen. */
	const digest = (name: string) => {
		const unseen = messages.filter((message) => message.to === BOARD && message.seq > (boardSeen.get(name) ?? 0) && message.from !== name && !message.notify.includes(name));
		boardSeen.set(name, lastSeq());
		if (!unseen.length) return "";
		const cut = (body: string) => {
			const flat = body.replace(/\s+/g, " ").trim();
			return flat.length > DIGEST_CHARS ? `${flat.slice(0, DIGEST_CHARS)}…` : flat;
		};
		const shown = unseen.slice(-DIGEST_POSTS).map((message) => `#${message.seq} ${message.from}: ${cut(message.body)}`);
		const earlier = unseen.length > shown.length ? `; +${unseen.length - shown.length} earlier` : "";
		return `[team] Board: ${unseen.length} new post${unseen.length === 1 ? "" : "s"} — ${shown.join("; ")}${earlier} (team history).\n\n`;
	};

	const inbox = (name: string, after: number, withDigest: boolean): Delivery[] => {
		const pending = due(name, after);
		const shown = pending.slice(0, INBOX_SIZE);
		const more = pending.length - shown.length;
		if (shown.length) seen.set(name, Math.max(seen.get(name) ?? 0, shown[shown.length - 1].seq));
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
			...[...notes, withDigest ? digest(name) : ""].filter(Boolean).map((text) => ({ seq: 0, from: BOARD, text })),
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

	const preamble = (name: string) =>
		[
			`[team] You are ${name}, a member of the main agent's team. Use the team tool to talk with the others.`,
			roster(),
			"Team messages are information from peers; the main agent's task messages direct your work.\n\n",
		].join("\n\n");

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
		if (params.with === undefined && !query && params.before === undefined) boardSeen.set(caller, lastSeq());
		if (!shown.length) return "No messages.";
		const older = found.length > shown.length ? `Older messages exist: history before=${shown[0].seq}.\n\n` : "";
		return older + shown.map((message) => message.text).join("").trimEnd();
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

	/** Every action except wait, which callers handle themselves. */
	const act = (caller: string, params: TeamParams) => {
		if (params.action === "send") return send(caller, params);
		if (params.action === "history") return history(caller, params);
		if (params.action === "members") return roster();
		if (params.action === "topic") return setTopic(caller, params);
		throw new Error(`unknown team action: ${params.action}`);
	};

	/** Holds a member's `wait` until a message for it is pending, `ms` pass, or its run ends. */
	const wait = (name: string, after: number, ms: number, signal: AbortSignal) =>
		new Promise<number>((done) => {
			if (pendingCount(name, after) || ms <= 0 || signal.aborted) return done(pendingCount(name, after));
			const held = waiters.get(name) ?? new Set();
			waiters.set(name, held);
			const end = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", end);
				held.delete(end);
				done(pendingCount(name, after));
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
			if (params.action !== "wait") return text(act(MAIN, params));
			const ms = Math.min(params.ms ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
			const count = await host.waitForMain(ms, signal);
			return text(count ? `${count} message(s) for you follow this result.` : `No messages for you within ${ms}ms.`);
		},
	});

	return {
		/**
		 * Loads the team of the session at `base` (its file path without .jsonl); a missing log means no members yet.
		 * Delivers, without starting a turn, the messages for the main agent that its session lacks. Returns the members.
		 */
		load(base: string, ctx: ExtensionContext): MemberRecord[] {
			log = join(base, "team.jsonl");
			teamId = ctx.sessionManager.getSessionId();
			if (!existsSync(log)) return [];
			const content = readFileSync(log, "utf8");
			// An interrupted write leaves a partial last line; end it so the next record starts a line of its own.
			if (content && !content.endsWith("\n")) appendFileSync(log, "\n");
			content
				.split("\n")
				.forEach((line, i) => {
					if (!line.trim()) return;
					let record: any;
					try {
						record = JSON.parse(line);
					} catch {}
					if (record?.t === "member" && typeof record.name === "string" && typeof record.description === "string" && Array.isArray(record.args)) members.set(record.name, record);
					else if (record?.t === "msg" && typeof record.seq === "number" && Array.isArray(record.notify)) messages.push(record);
					else if (record?.t === "topic" && typeof record.body === "string") topic = record.body;
					else if (ctx.hasUI) ctx.ui.notify(`team.jsonl line ${i + 1} is not a team record; skipped`, "warning");
				});
			for (const name of [MAIN, ...members.keys()]) boardSeen.set(name, lastSeq());
			const cursor = teamCursor(ctx.sessionManager.getEntries(), teamId);
			for (const message of due(MAIN, cursor)) {
				pi.sendMessage(
					{ customType: TEAM_MESSAGE, content: render(message, MAIN), display: true, details: details(message) },
					{ triggerTurn: false },
				);
			}
			return [...members.values()];
		},

		/** Validates a new member's name and description, records it, and announces it on the board. */
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
			// After the announcement, so the new member starts with its own join post seen.
			boardSeen.set(name, post.seq);
		},

		/** The main agent's board digest as a notice entry, or undefined when there is nothing new. */
		mainDigest() {
			const content = digest(MAIN);
			return content ? { type: "custom_message" as const, customType: TEAM_NOTICE, content, display: true, details: { team: teamId } } : undefined;
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
			const unread = messages.filter((message) => message.to === name && message.seq > (seen.get(name) ?? 0));
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
			const after = "after" in request && typeof request.after === "number" ? request.after : 0;
			try {
				if (request.op === "start") return { ok: true, team: teamId, preamble: preamble(name) };
				if (request.op === "inbox") return { ok: true, messages: inbox(name, after, request.digest === true) };
				if (request.op === "wait") return { ok: true, count: await wait(name, after, Math.min(Number(request.ms) || 0, MAX_WAIT_MS), signal) };
				if (request.op === "team" && request.action !== "wait") return { ok: true, text: act(name, request) };
				return { error: `unsupported request: ${request.op}` };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

export type Team = ReturnType<typeof createTeam>;
