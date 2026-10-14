// Run in a disposable Linux container: this deliberately tests an unresponsive child's kill fallback.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const entryDir = dirname(realpathSync(process.env.PI_CLI));
const piDir = dirname(basename(entryDir) === "bundle" ? dirname(entryDir) : entryDir);
const requirePi = createRequire(join(piDir, "package.json"));
const { createJiti } = requirePi("jiti");
const resolvePi = createJiti(join(piDir, "package.json"));
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": join(piDir, "dist/bundle/index.js"),
		"@earendil-works/pi-ai": fileURLToPath(resolvePi.esmResolve("@earendil-works/pi-ai")),
		typebox: fileURLToPath(resolvePi.esmResolve("typebox")),
	},
});
const { startRun } = await jiti.import("../src/rpc.ts");

const deadline = setTimeout(() => { throw new Error("POSIX cleanup probe timed out"); }, 45_000).unref();
const dir = mkdtempSync(join(tmpdir(), "rpc-posix-"));
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
const fixture = join(dir, "probe.ts");
writeFileSync(fixture, `
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
export default function(pi) {
  let mode;
  pi.on("session_shutdown", async () => {
    if (mode !== "finish") await new Promise(() => {});
    await delay(1_500);
    writeFileSync("disposed", "yes");
  });
  pi.registerCommand("probe", { description: "POSIX cleanup probe", handler: async (args) => {
    mode = args;
    writeFileSync("parent.pid", String(process.pid));
    if (mode === "ignore-term") {
      process.removeAllListeners("SIGTERM");
      process.on("SIGTERM", () => {});
    }
    let ready;
    const started = new Promise((resolve) => { ready = resolve; });
    const shell = createLocalBashOperations().exec("echo $$ > shell.pid; sleep 60 & echo $! > leaf.pid; echo ready; wait", process.cwd(), { onData: () => ready() });
    await started;
    if (mode !== "finish") await shell;
  }});
}
`);

function state(pid) {
	try {
		const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ");
		return { live: fields[2] !== "Z", parent: Number(fields[3]) };
	} catch (error) {
		if (error.code === "ENOENT") return { live: false };
		throw error;
	}
}
async function until(check, message) {
	for (let i = 0; i < 200; i++) {
		if (check()) return;
		await delay(50);
	}
	assert.fail(message);
}

try {
	for (const mode of ["stop", "fail", "shutdown", "finish", "ignore-term"]) {
		const cwd = mkdtempSync(join(dir, `${mode}-`));
		let ends = 0;
		const run = startRun({
			cwd,
			args: ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "-e", fixture],
			launch: { type: "prompt", message: `/probe ${mode}` },
			owner: { onEvent() {}, async onRequest() {}, onEnd() { ends++; } },
		});
		let shell, leaf, parent, repeat;
		try {
			await until(() => {
				try {
					shell = Number(readFileSync(join(cwd, "shell.pid"), "utf8"));
					leaf = Number(readFileSync(join(cwd, "leaf.pid"), "utf8"));
					return shell > 0 && leaf > 0;
				} catch (error) {
					if (error.code === "ENOENT") return false;
					throw error;
				}
			}, `${mode}: shell did not start`);
			parent = Number(readFileSync(join(cwd, "parent.pid"), "utf8"));
			assert(state(parent).live, `${mode}: Pi is running`);
			if (mode !== "finish") assert(state(shell).live && state(leaf).live, `${mode}: fixture is running`);
			if (mode === "ignore-term") repeat = setInterval(() => run.fail("repeat termination"), 100);
			if (mode === "fail") run.fail("probe failure");
			else if (mode === "shutdown") await run.shutdown();
			else if (mode !== "finish") await run.stop();
			await until(() => !state(parent).live, `${mode}: Pi did not exit`);
			await run.exited;
			assert.equal(ends, 1, `${mode}: reports one end`);
			if (mode === "finish") assert.equal(readFileSync(join(cwd, "disposed"), "utf8"), "yes", "normal finish preserves disposal grace");
			if (mode !== "ignore-term") {
				await until(() => !state(shell).live && !state(leaf).live, `${mode}: live shell descendant survived`);
			}
			console.log(`ok: ${mode}`);
		} finally {
			clearInterval(repeat);
			if (parent && state(parent).live) process.kill(parent, "SIGKILL");
			if (shell) { try { process.kill(-shell, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
		}
	}
} finally {
	clearTimeout(deadline);
	rmSync(dir, { recursive: true, force: true });
}
