/**
 * Pi subagents as `pi --mode rpc` child processes bound to the parent session.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import setupChild from "./child.ts";
import { CHILD_ENV } from "./protocol.ts";
import setupParent from "./subagent.ts";

const ROLE: unique symbol = Symbol.for("pi-subagent-rpc-extension.role");

export default function (pi: ExtensionAPI) {
	// The role leaves the environment so nothing the child starts, such as a Pi launched from bash, takes itself
	// for a subagent; it stays in process-global state because a reload runs this factory again in the same process.
	const global = globalThis as { [ROLE]?: string };
	global[ROLE] ??= process.env[CHILD_ENV] ?? "";
	delete process.env[CHILD_ENV];
	if (global[ROLE]) setupChild(pi, global[ROLE] === "team");
	else setupParent(pi);
}
