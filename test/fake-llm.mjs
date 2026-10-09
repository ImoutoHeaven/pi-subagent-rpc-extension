// Scripted OpenAI-compatible endpoint for the end-to-end test; logs every request body.
// The last message decides the reply:
//   tool result                      → "ack" (parent turn after a subagent call)
//   "CALL <json>"                    → a `subagent` tool call with those arguments
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

async function reply(body) {
	const last = body.messages.at(-1);
	if (last.role === "tool") return { content: "ack" };
	let said = text(last).trim();
	if (said.startsWith("CALL ")) return { call: said.slice(5) };
	if (/^\[(settled|aborted|error)\]/.test(said)) return { content: "notified" };
	const slow = said.match(/^SLOW (\d+) ([\s\S]*)$/);
	if (slow) {
		await sleep(Number(slow[1]));
		said = slow[2];
	}
	if (said === "HANG") return { hang: true };
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
				? { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "subagent", arguments: answer.call } }] }
				: { role: "assistant", content: answer.content };
			chunk([{ index: 0, delta, finish_reason: null }]);
			chunk([{ index: 0, delta: {}, finish_reason: answer.call ? "tool_calls" : "stop" }]);
			chunk([], { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
			res.end("data: [DONE]\n\n");
		});
	})
	.listen(Number(port), "127.0.0.1");
