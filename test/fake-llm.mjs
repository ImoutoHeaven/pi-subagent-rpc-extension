// Scripted OpenAI-compatible endpoint for the end-to-end test; logs every request body.
// The last message decides the reply:
//   tool result                      → "ack" (parent turn after a subagent call), except:
//                                      after "CALL <json> HOLD" → never answer;
//                                      first result after "CALLS <ms> <a> || <b>" → wait, then call <b>
//   "CALL <json>[ HOLD]"              → a `subagent` tool call with those arguments
//   "CALLS <ms> <a> || <b>"           → a `subagent` call with <a>
//   "REPORT <text>"                  → a `report_to_main_agent` call, then "reported"
//   "<fork note>\n\nTask:\n<rest>"     → handle <rest>
//   "[settled|aborted|error] ..."    → "notified" (a delivered subagent result)
//   "SLOW <ms> <rest>"               → wait, then handle <rest>
//   "HANG"                           → never answer
//   "TOOLS?"                         → the declared tool names
//   "SAY <text>"                     → <text>
import fs from "node:fs";
import http from "node:http";

const [log, port = "8787"] = process.argv.slice(2);
const text = (m) => (typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join(""));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const CALLS = /^CALLS (\d+) (\{.*?\}) \|\| (\{.*\})$/s;

async function reply(body) {
	const last = body.messages.at(-1);
	if (last.role === "tool") {
		const start = body.messages.findLastIndex((m) => m.role === "user" && text(m).startsWith("CALL"));
		if (start === -1) return { content: "reported" };
		const call = text(body.messages[start]);
		const calls = call.match(CALLS);
		if (calls && body.messages.slice(start).filter((m) => m.role === "tool").length === 1) {
			await sleep(Number(calls[1]));
			return { call: calls[3] };
		}
		return call.endsWith(" HOLD") ? { hang: true } : { content: "ack" };
	}
	let said = text(last).trim().replace(/^[\s\S]*\n\nTask:\n/, "");
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
	if (said.startsWith("REPORT ")) return { call: JSON.stringify({ message: said.slice(7) }), name: "report_to_main_agent" };
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
