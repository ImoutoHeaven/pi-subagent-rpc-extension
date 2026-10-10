// Scripted OpenAI-compatible endpoint for the end-to-end test; logs every request body.
// Team messages (user messages starting with "[team") are skipped, except that a woken member's launch note
// ("... sent you a team message. Act on ...") is replaced by the body of the last team message its run starts with.
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
//   "[settled|aborted|error] ..."    → "notified" (a delivered subagent result)
//   "SLOW <ms> <rest>"               → wait, then handle <rest>
//   "HANG"                           → never answer
//   "TOOLS?"                         → the declared tool names
//   "SAY <text>"                     → <text>
import fs from "node:fs";
import http from "node:http";

const [log, port = "8787"] = process.argv.slice(2);
const text = (m) => (typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join(""));
const script = (m) => text(m).trim();
/** The scripted call a prompt makes, without its delay. */
const callOf = (m) => script(m).replace(/^SLOW \d+ /, "");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const CALLS = /^CALLS (\d+) (\{.*?\}) \|\| (\{.*\})$/s;
const WOKEN = /sent you a team message\. Act on your team messages/;
const isTeam = (m) => m.role === "user" && text(m).startsWith("[team");
/** The body of the last team message in a run's start message. */
const lastBody = (start) => text(start).split(/\[team #\d+\][^\n]*:\n/).at(-1).trim();

async function reply(body) {
	const messages = body.messages.flatMap((m, i, all) =>
		m.role === "user" && WOKEN.test(text(m)) ? [{ role: "user", content: lastBody(all[i + 1]) }] : isTeam(m) ? [] : [m],
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
	const calls = said.match(CALLS);
	if (calls) return { call: calls[2] };
	if (said.startsWith("CALL ")) return { call: said.slice(5).replace(/ HOLD$/, "") };
	if (/^\[(settled|aborted|error)\]/.test(said)) return { content: "notified" };
	const slow = said.match(/^SLOW (\d+) ([\s\S]*)$/);
	if (slow) {
		await sleep(Number(slow[1]));
		said = slow[2];
	}
	if (said === "HANG") return { hang: true };
	if (said.startsWith("TEAM ")) return { call: said.slice(5), name: "team" };
	if (said.startsWith("TEAMS ")) return { call: said.slice(6).split(" || ")[0], name: "team" };
	if (said === "RELOAD") return { call: "{}", name: "reload_now" };
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
			const chunk = (choices, extra = {}) =>
				res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake-model", choices, ...extra })}\n\n`);
			const delta = answer.call
				? { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: answer.name ?? "subagent", arguments: answer.call } }] }
				: { role: "assistant", content: answer.content };
			chunk([{ index: 0, delta, finish_reason: null }]);
			chunk([{ index: 0, delta: {}, finish_reason: answer.call ? "tool_calls" : "stop" }]);
			chunk([], { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
			res.end("data: [DONE]\n\n");
		});
	})
	.listen(Number(port), "127.0.0.1");
