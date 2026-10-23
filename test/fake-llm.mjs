// Scripted OpenAI-compatible endpoint for the end-to-end test; logs every request body.
// Team messages and subagent notices (user messages starting with "[team" or "[subagent]") are skipped, except that a woken member's launch note
// ("... sent you a team message. Act on ...") is replaced by the body of the last team message its run starts with,
// without the board digest that may follow it, and the note that resumes a run after a compaction at its safe point is replaced by the main agent's message in it.
// The last other message decides the reply:
//   assistant                        → "notified" (only team messages arrived)
//   tool result                      → "ack" (parent turn after a subagent call), except:
//                                      after "CALL <json> HOLD" → never answer;
//                                      first result after "CALLS <ms> <a> || <b>" → wait, then call <b>;
//                                      after "TEAM <json>" → "team: <tool result>";
//                                      nth result after "TEAMS <a> || <b> ..." → the next `team` call, or after the last "team: <tool result>";
//                                      after "RELOAD" → the declared tool names
//   "CALL <json>[ HOLD]"              → a `subagent` tool call with those arguments
//   "CALLS <ms> <a> || <b>"           → a `subagent` call with <a>
//   "TEAM <json>"                     → a `team` tool call with those arguments
//   "TEAMS <a> || <b> ..."            → a `team` call with <a>
//   "RELOAD"                         → a `reload_now` tool call
//   "BASH <command>"                 → a `bash` tool call running <command>
//   "TOOL <name> <json>"             → a call of tool <name> with those arguments
//   "[settled|aborted|error|compacted] ..." → "notified" (a delivered subagent result)
//   "FAIL <message>"                 → a stream that fails with <message>
//   "SLOW <ms> <rest>"               → wait, then handle <rest>
//   "HANG"                           → never answer
//   "TOOLS?"                         → the declared tool names
//   "SAY <text>"                     → <text>
//   "<conversation>..."              → "summary" (a compaction request); custom instructions "SLOW <ms>" wait first
//   "USAGE <n>,<m>,... <rest>"       → handle <rest>; the replies of that run report <n>, then <m>, ... prompt tokens
// Every other reply reports 1500 prompt tokens, 1000 of them cached, and 200 completion tokens.
const USAGE = /^USAGE ([\d,]+) /;
import fs from "node:fs";
import http from "node:http";

const [log, port = "8787"] = process.argv.slice(2);
const text = (m) => (typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join(""));
const script = (m) => text(m).trim().replace(USAGE, "");
/** The prompt tokens a reply reports: by its place after the last USAGE prompt, or 1500. */
const promptTokens = (messages) => {
	const start = messages.findLastIndex((m) => m.role === "user" && USAGE.test(text(m).trim()));
	if (start === -1) return 1500;
	const steps = text(messages[start]).trim().match(USAGE)[1].split(",").map(Number);
	return steps[Math.min(messages.slice(start).filter((m) => m.role === "assistant").length, steps.length - 1)];
};
/** The scripted call a prompt makes, without its delay. */
const callOf = (m) => script(m).replace(/^SLOW \d+ /, "");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const CALLS = /^CALLS (\d+) (\{.*?\}) \|\| (\{.*\})$/s;
// The whole message, so a summarizer prompt that quotes a launch note is not one.
const WOKEN = /^.* sent you a team message\. Act on your team messages\.$/;
const RESUMED = /^The main agent (?:compacted|asked to compact) your context at this point of your run[^\n]*\. Continue your task\.\n\nThe main agent's message:\n([\s\S]*)$/;
const isTeam = (m) => m.role === "user" && /^\[(team|subagent\])/.test(text(m));
/** The body of the last team message in a run's start message. */
const lastBody = (start) => text(start).split(/\[team #\d+\][^\n]*\n/).at(-1).split("\n[team] Board: ")[0].trim();

async function reply(body) {
	const messages = body.messages.flatMap((m, i, all) =>
		m.role === "user" && WOKEN.test(text(m))
			? [{ role: "user", content: lastBody(all[i + 1]) }]
			: m.role === "user" && RESUMED.test(text(m))
				? [{ role: "user", content: text(m).match(RESUMED)[1] }]
				: isTeam(m)
					? []
					: [m],
	);
	const last = messages.at(-1);
	if (last.role === "assistant") return { content: "notified" };
	if (last.role === "tool") {
		const start = messages.findLastIndex((m) => m.role === "user" && /^(CALLS?|TEAMS?) |^RELOAD$/.test(callOf(m)));
		const call = start === -1 ? "" : callOf(messages[start]);
		if (call.startsWith("TEAM ")) return { content: `team: ${text(last)}` };
		if (call === "RELOAD") return { content: `tools: ${(body.tools || []).map((t) => t.function.name).join(",")}` };
		if (call.startsWith("TEAMS ")) {
			const steps = call.slice(6).split(" || ");
			const done = messages.slice(start).filter((m) => m.role === "tool").length;
			return done < steps.length ? { call: steps[done], name: "team" } : { content: `team: ${text(last)}` };
		}
		const calls = call.match(CALLS);
		if (calls && messages.slice(start).filter((m) => m.role === "tool").length === 1) {
			await sleep(Number(calls[1]));
			return { call: calls[3] };
		}
		return call.endsWith(" HOLD") ? { hang: true } : { content: "ack" };
	}
	let said = script(last);
	if (said.startsWith("<conversation>")) {
		await sleep(Number(said.match(/Additional focus: SLOW (\d+)$/)?.[1] ?? 0));
		return { content: "summary" };
	}
	const calls = said.match(CALLS);
	if (calls) return { call: calls[2] };
	if (said.startsWith("CALL ")) return { call: said.slice(5).replace(/ HOLD$/, "") };
	if (/^\[(settled|aborted|error|compacted)\]/.test(said)) return { content: "notified" };
	const slow = said.match(/^SLOW (\d+) ([\s\S]*)$/);
	if (slow) {
		await sleep(Number(slow[1]));
		said = slow[2];
	}
	if (said === "HANG") return { hang: true };
	if (said.startsWith("FAIL ")) return { fail: said.slice(5) };
	if (said.startsWith("TEAM ")) return { call: said.slice(5), name: "team" };
	if (said.startsWith("TEAMS ")) return { call: said.slice(6).split(" || ")[0], name: "team" };
	if (said === "RELOAD") return { call: "{}", name: "reload_now" };
	if (said.startsWith("BASH ")) return { call: JSON.stringify({ command: said.slice(5) }), name: "bash" };
	const tool = said.match(/^TOOL (\S+) ([\s\S]*)$/);
	if (tool) return { call: tool[2], name: tool[1] };
	if (said === "TOOLS?") return { content: `tools: ${(body.tools || []).map((t) => t.function.name).join(",")}` };
	if (said.startsWith("SAY ")) return { content: said.slice(4) };
	return { content: `unscripted: ${said.slice(0, 80)}` };
}

http
	.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", async () => {
			const body = raw ? JSON.parse(raw) : {};
			fs.appendFileSync(log, `${JSON.stringify(body)}\n`);
			if (!req.url.endsWith("/chat/completions")) {
				res.writeHead(404);
				return res.end();
			}
			const answer = await reply(body);
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (answer.hang) return; // the client aborts
			// An error event in the stream, which the OpenAI SDK raises with its message.
			if (answer.fail) return res.end(`data: ${JSON.stringify({ error: { message: answer.fail } })}\n\n`);
			const chunk = (choices, extra = {}) =>
				res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake-model", choices, ...extra })}\n\n`);
			const delta = answer.call
				? { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: answer.name ?? "subagent", arguments: answer.call } }] }
				: { role: "assistant", content: answer.content };
			chunk([{ index: 0, delta, finish_reason: null }]);
			chunk([{ index: 0, delta: {}, finish_reason: answer.call ? "tool_calls" : "stop" }]);
			const prompt = promptTokens(body.messages);
			chunk([], { usage: { prompt_tokens: prompt, completion_tokens: 200, total_tokens: prompt + 200, prompt_tokens_details: { cached_tokens: 1000 } } });
			res.end("data: [DONE]\n\n");
		});
	})
	.listen(Number(port), "127.0.0.1");
