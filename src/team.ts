/**
 * Team state: the log, routing, history, the main agent's `team` tool, and answers to members' requests.
 * It has no path to a process: it only asks whether a member is running and hands messages for the main agent to the host.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const NAME = /^[a-z][a-z0-9-]{0,22}[a-z0-9]$/;
// `team` marks the board in the log's `to` field.
const RESERVED = new Set([MAIN, "all", BOARD]);
const INBOX_SIZE = 10;
const HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 50;
const HISTORY_CHARS = 16_000;

export interface MemberRecord {
	t: "member";
	name: string;
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
}
/** The log's first record: the team's id, which is the id of the session that ran /team. */
interface TeamRecord {
	t: "team";
	id: string;
}
interface TopicRecord {
	t: "topic";
	at: number;
	body: string;
}

export interface TeamHost {
	isRunning(name: string): boolean;
	/** Delivers a message to the main agent. */
	notify(customType: string, from: string, text: string, details: object): void;
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
	/** The log path; set exactly when this session is in team mode. */
	let log: string | undefined;
	let teamId = "";
	const members = new Map<string, MemberRecord>();
	let messages: MessageRecord[] = [];
	let topic = "";
	/** Held `wait` requests by member. */
	const waiters = new Map<string, Set<() => void>>();

	const append = (record: MemberRecord | MessageRecord | TopicRecord) => appendFileSync(log as string, `${JSON.stringify(record)}\n`);
	const details = (message: MessageRecord) => ({ team: teamId, seq: message.seq, from: message.from });

	const activate = (on: boolean) => {
		const others = pi.getActiveTools().filter((name) => name !== "team");
		pi.setActiveTools(on ? [...others, "team"] : others);
	};

	const known = (name: string) => {
		if (name !== MAIN && !members.has(name)) throw new Error(`Unknown member: ${name}. Members: ${[MAIN, ...members.keys()].join(", ")}`);
		return name;
	};

	const state = (name: string) => (name === MAIN ? "main agent" : host.isRunning(name) ? "running" : "stopped");

	const roster = () =>
		[
			"Members:",
			...[MAIN, ...members.keys()].map((name) => `- ${name}: ${state(name)}`),
			`Topic: ${topic || "(none)"}`,
		].join("\n");

	const due = (name: string, after: number) => messages.filter((message) => message.seq > after && message.notify.includes(name));

	const inbox = (name: string, after: number): Delivery[] => {
		const pending = due(name, after);
		const shown = pending.slice(0, INBOX_SIZE);
		const more = pending.length - shown.length;
		return shown.map((message, i) => ({
			seq: message.seq,
			from: message.from,
			text: render(message, name) + (more && i === shown.length - 1 ? `(${more} more team messages for you are pending; they arrive after your next tool call.)\n\n` : ""),
		}));
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
		};
		append(message);
		messages.push(message);
		for (const name of notify) for (const wake of [...(waiters.get(name) ?? [])]) wake();
		if (notify.includes(MAIN)) host.notify(TEAM_MESSAGE, from, render(message, MAIN), details(message));
		if (!notify.length) return `Posted #${message.seq}. It notified nobody; members see it in history.`;
		const stopped = notify.filter((name) => state(name) === "stopped");
		const resume =
			from === MAIN
				? "A stopped member sees it when you resume it with subagent follow_up."
				: "A stopped member sees it when the main agent resumes it; ask the main agent if it needs to act.";
		return [`Sent #${message.seq} to ${notify.map((name) => `${name} (${state(name)})`).join(", ")}.`, stopped.length ? resume : ""].filter(Boolean).join(" ");
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
			if (due(name, after).length || ms <= 0 || signal.aborted) return done(due(name, after).length);
			const held = waiters.get(name) ?? new Set();
			waiters.set(name, held);
			const end = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", end);
				held.delete(end);
				done(due(name, after).length);
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
			if (!log) throw new Error("This session is not in team mode.");
			if (params.action !== "wait") return text(act(MAIN, params));
			const ms = Math.min(params.ms ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
			const count = await host.waitForMain(ms, signal);
			return text(count ? `${count} message(s) for you follow this result.` : `No messages for you within ${ms}ms.`);
		},
	});

	return {
		get active() {
			return Boolean(log);
		},

		/**
		 * Loads the team of the session at `base` (its file path without .jsonl), or leaves the session in normal mode.
		 * Delivers, without starting a turn, the messages for the main agent that its session lacks. Returns the members.
		 */
		load(base: string, ctx: ExtensionContext): MemberRecord[] {
			const file = join(base, "team.jsonl");
			log = existsSync(file) ? file : undefined;
			activate(Boolean(log));
			if (!log) return [];
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
					if (record?.t === "team" && typeof record.id === "string") teamId = record.id;
					else if (record?.t === "member" && typeof record.name === "string" && Array.isArray(record.args)) members.set(record.name, record);
					else if (record?.t === "msg" && typeof record.seq === "number" && Array.isArray(record.notify)) messages.push(record);
					else if (record?.t === "topic" && typeof record.body === "string") topic = record.body;
					else if (ctx.hasUI) ctx.ui.notify(`team.jsonl line ${i + 1} is not a team record; skipped`, "warning");
				});
			const cursor = teamCursor(ctx.sessionManager.getEntries(), teamId);
			for (const message of due(MAIN, cursor)) {
				pi.sendMessage(
					{ customType: TEAM_MESSAGE, content: render(message, MAIN), display: true, details: details(message) },
					{ triggerTurn: false },
				);
			}
			return [...members.values()];
		},

		/** Starts team mode for the session at `base`, whose session id is `id`. */
		create(base: string, id: string) {
			mkdirSync(base, { recursive: true });
			log = join(base, "team.jsonl");
			teamId = id;
			writeFileSync(log, `${JSON.stringify({ t: "team", id } satisfies TeamRecord)}\n`, { flag: "wx" });
			activate(true);
		},

		/** Validates a new member's name and records it. */
		hire(name: string, cwd: string, args: string[]) {
			if (!NAME.test(name)) throw new Error(`name must match ${NAME.source}`);
			if (RESERVED.has(name)) throw new Error(`${name} is reserved`);
			if (members.has(name)) throw new Error(`${name} is already a member; resume it with follow_up`);
			const member: MemberRecord = { t: "member", name, cwd, args };
			append(member);
			members.set(name, member);
		},

		/** Answers a member's request. */
		async answer(name: string, request: Request, signal: AbortSignal): Promise<Reply> {
			const after = "after" in request && typeof request.after === "number" ? request.after : 0;
			try {
				if (request.op === "start") return { ok: true, team: teamId, preamble: preamble(name) };
				if (request.op === "inbox") return { ok: true, messages: inbox(name, after) };
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
