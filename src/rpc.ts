/**
 * One run of a subagent: a `pi --mode rpc` process that lives from its launch prompt until the run concludes.
 * It reports events, child requests, and the run's end to its owner.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { CHILD_ENV, type Reply, type Request, TAG } from "./protocol.ts";

const ABORT_WAIT_MS = 10_000;
const KILL_AFTER_MS = 5_000;
const STDERR_CHARS = 2_000;
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

export type RunStatus = "settled" | "aborted" | "error";
export type Response = { success: boolean; disposition?: string; error?: string };
interface Command {
	id: string;
	type: "prompt" | "clear_queue" | "abort";
	message?: string;
	streamingBehavior?: "steer" | "followUp";
}

export interface RunOwner {
	/** Every record the child writes, before the run's own bookkeeping. */
	onEvent(event: any): void;
	/** A child request. Resolves to the reply, or undefined for none. The signal aborts when the run concludes. */
	onRequest(request: Request, signal: AbortSignal): Promise<Reply | undefined>;
	/** The run concluded; called once. */
	onEnd(status: RunStatus, error: string | null): void;
}

export interface Run {
	readonly finished: boolean;
	/** Resolves once the process has exited. */
	readonly exited: Promise<void>;
	prompt(message: string, streamingBehavior: "steer" | "followUp"): Promise<Response>;
	/** Ends the run as an error and kills the process. */
	fail(error: string): void;
	/** Clears the queue and aborts; kills the process if the run does not conclude within 10 seconds. */
	stop(signal?: AbortSignal): Promise<void>;
	/** Ends the process whatever its state, for the end of the parent session. */
	shutdown(): Promise<void>;
}

const hex = () => randomBytes(4).toString("hex");

function killTree(child: ChildProcessWithoutNullStreams) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	// shortcut: on POSIX only Pi itself is signalled; its tool processes rely on Pi's own cleanup.
	if (process.platform === "win32" && child.pid) {
		spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
	} else child.kill("SIGKILL");
}

/** The promise's value, or undefined once `ms` pass or `signal` aborts. */
export function within<T>(promise: Promise<T>, ms: number, signal?: AbortSignal) {
	return new Promise<T | undefined>((done) => {
		const settle = (value: T | undefined) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			done(value);
		};
		const cancel = () => settle(undefined);
		const timer = setTimeout(cancel, ms);
		if (signal?.aborted) return cancel();
		signal?.addEventListener("abort", cancel, { once: true });
		void promise.then(settle);
	});
}

/** Starts a child on `message`. */
export function startRun(options: { cwd: string; args: string[]; message: string; owner: RunOwner }): Run {
	const { owner } = options;
	// The host's runtime and Pi package, so the child runs the same Pi build even when the host is an SDK app.
	// shortcut: a Bun-compiled Pi binary has no rpc-entry file; add a path for it if such hosts need subagents.
	const pkg = getPackageDir();
	const entry = join(pkg, JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).exports["./rpc-entry"].import);
	const child = spawn(process.execPath, [entry, ...options.args], {
		cwd: options.cwd,
		env: { ...process.env, [CHILD_ENV]: "1" },
		stdio: "pipe",
		windowsHide: true,
	});
	const launchId = `run-${hex()}`;
	let queue: Command[] = [];
	const replies = new Map<string, (response: Response) => void>();
	let busy = false;
	/** A prompt that reached idle Pi; later commands wait until its run starts. */
	let gate: string | null = null;
	let probe: string | null = null;
	let lastStop: string | null = null;
	let lastError: string | null = null;
	/** The parent asked to stop; survives the child's own event resets. */
	let aborting = false;
	let finished = false;
	let stderr = "";
	const concluded = new AbortController();
	let markExited = () => {};
	const exited = new Promise<void>((done) => (markExited = done));

	const write = (record: object) => {
		if (child.stdin.writable) child.stdin.write(`${JSON.stringify(record)}\n`);
	};

	/** Fail commands that will never get a response. */
	const dropPending = (error: string, all: boolean) => {
		const ids = all ? [...replies.keys()] : queue.map((queued) => queued.id);
		for (const id of ids) replies.get(id)?.({ success: false, error });
		for (const id of ids) replies.delete(id);
		queue = [];
	};

	const finish = (status: RunStatus, error: string | null) => {
		if (finished) return;
		finished = true;
		dropPending(`subagent ${status}`, true);
		concluded.abort();
		child.stdin.end();
		setTimeout(() => killTree(child), KILL_AFTER_MS).unref();
		owner.onEnd(status, error);
	};

	const fail = (error: string) => {
		finish("error", error);
		killTree(child);
	};

	const conclude = () => {
		if (aborting || lastStop === "aborted") finish("aborted", null);
		else if (lastStop === "error") finish("error", lastError ?? "assistant error");
		else finish("settled", null);
	};

	// Pi's events can lag its state, so Pi's own isStreaming confirms a run is over.
	const maybeFinish = () => {
		if (finished || busy || gate || probe || queue.length || replies.size) return;
		probe = `probe-${hex()}`;
		write({ id: probe, type: "get_state" });
	};

	// A prompt reaching idle Pi starts a run; later prompts wait until it starts so they queue behind it.
	const pump = () => {
		while (!finished && queue.length && !gate) {
			const next = queue.shift() as Command;
			write(next);
			if (next.type === "prompt" && !busy) gate = next.id;
		}
		maybeFinish();
	};

	const send = (record: Omit<Command, "id">, id = `${record.type}-${hex()}`) =>
		new Promise<Response>((done) => {
			replies.set(id, done);
			queue.push({ ...record, id });
			pump();
		});

	const answer = async (event: { id: string; placeholder?: string }) => {
		let reply: Reply | undefined;
		try {
			reply = await owner.onRequest(JSON.parse(event.placeholder ?? ""), concluded.signal);
		} catch (error) {
			reply = { error: error instanceof Error ? error.message : String(error) };
		}
		if (reply && !finished) write({ type: "extension_ui_response", id: event.id, value: JSON.stringify(reply) });
	};

	const handle = (event: any) => {
		if (finished) return;
		owner.onEvent(event);
		if (finished) return;
		switch (event.type) {
			case "response": {
				if (event.id && event.id === probe) {
					probe = null;
					if (!event.success || typeof event.data?.isStreaming !== "boolean") finish("error", `state check failed: ${event.error ?? "no isStreaming"}`);
					// While streaming, the coming agent_settled checks again.
					else if (!event.data.isStreaming && !busy && !gate && !queue.length && !replies.size) conclude();
					return;
				}
				const reply = replies.get(event.id);
				if (!reply) return;
				replies.delete(event.id);
				const response: Response = { success: Boolean(event.success), disposition: event.data?.disposition, error: event.error };
				if (event.id === launchId && !response.success) {
					lastStop = "error";
					lastError = response.error ?? "prompt rejected";
				}
				if (response.disposition === "started") gate = event.id;
				else if (event.id === gate) gate = null;
				reply(response);
				pump();
				return;
			}
			case "agent_start":
				busy = true;
				gate = null;
				lastStop = null;
				pump();
				return;
			case "message_end":
				if (event.message?.role !== "assistant") return;
				lastStop = event.message.stopReason ?? null;
				if (lastStop === "error") lastError = event.message.errorMessage ?? "assistant error";
				return;
			case "agent_settled":
				busy = false;
				gate = null;
				pump();
				return;
			case "extension_ui_request":
				if (event.method === "input" && event.title === TAG) void answer(event);
				// No one can answer any other dialog; cancelling keeps it from blocking forever.
				else if (DIALOGS.has(event.method)) write({ type: "extension_ui_response", id: event.id, cancelled: true });
				return;
		}
	};

	child.stdin.on("error", () => {});
	child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-STDERR_CHARS)));
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += decoder.write(chunk);
		let newline: number;
		while ((newline = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (!line.trim()) continue;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return fail(`invalid RPC output: ${line.slice(0, 200)}`);
			}
			handle(event);
		}
	});
	let ended = false;
	const closed = (reason: string, clean = false) => {
		if (ended) return;
		ended = true;
		if (aborting) finish("aborted", null);
		else if (clean && !busy && !gate && !queue.length) conclude();
		else finish("error", `${reason}${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
		markExited();
	};
	child.on("error", (error) => closed(`could not run Pi: ${error.message}`));
	// "close" fires once stdout drains, so every event is handled first. A descendant that inherited
	// the pipes can hold "close" back indefinitely, so a settled "exit" also ends the process.
	const onExit = (code: number | null, signal: NodeJS.Signals | null) => closed(`Pi exited (code ${code}, signal ${signal})`, code === 0);
	child.on("close", onExit);
	child.on("exit", (code, signal) => setTimeout(() => onExit(code, signal), 2_000).unref());
	void send({ type: "prompt", message: options.message }, launchId);

	return {
		get finished() {
			return finished;
		},
		exited,
		prompt: (message, streamingBehavior) => send({ type: "prompt", message, streamingBehavior }),
		fail,
		async stop(signal) {
			if (finished) return;
			dropPending("subagent aborted", false);
			write({ type: "clear_queue" });
			write({ type: "abort" });
			aborting = true;
			await within(new Promise((done) => concluded.signal.addEventListener("abort", done)), ABORT_WAIT_MS, signal);
			if (finished) return;
			killTree(child);
			await exited;
		},
		async shutdown() {
			if (!finished) {
				// Abort first: Pi in RPC mode finishes an active run before honouring stdin EOF.
				aborting = true;
				write({ type: "clear_queue" });
				write({ type: "abort" });
			}
			child.stdin.end();
			if ((await within(exited.then(() => true), 3_000)) === undefined) {
				killTree(child);
				await within(exited, 2_000);
			}
		},
	};
}
