/**
 * End-to-end smoke test. Run from a herdr-app terminal:
 *
 *   node test/smoke.ts
 *
 * Launches a real child through hc, waits for its report, and prints what the
 * parent would have received. Requires `hc` and HC_TERMINAL_ID.
 */
import { execFile } from "node:child_process";
import piHcSubagents from "../src/index.ts";

function hcCode(args: string[]): Promise<number> {
	return new Promise((resolve) => {
		execFile("hc", args, { timeout: 20_000 }, (error) => {
			resolve(error ? 1 : 0);
		});
	});
}

type Registered = { name: string; execute: (id: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any> };

const tools = new Map<string, Registered>();
const messages: { content: string; options: unknown }[] = [];

const pi = {
	registerTool(tool: Registered) {
		tools.set(tool.name, tool);
	},
	sendMessage(message: { content: string }, options: unknown) {
		messages.push({ content: message.content, options });
	},
} as never;

piHcSubagents(pi);

const subagent = tools.get("subagent");
if (!subagent) throw new Error("subagent tool was not registered");
console.log("registered tools:", [...tools.keys()].join(", "));

const result = await subagent.execute(
	"smoke-1",
	{ agent: "scout", task: "Reply with exactly one line: SMOKE OK. Then stop.", name: "smoke-child", title: "Smoke" },
	undefined,
	undefined,
	{ cwd: process.cwd() },
);
console.log("launch result:", result.content[0].text);

const deadline = Date.now() + 180_000;
while (!messages.length && Date.now() < deadline) {
	await new Promise((resolve) => setTimeout(resolve, 1000));
}

if (!messages.length) {
	console.error("FAIL: no report arrived within 180s");
	process.exit(1);
}
console.log("\n=== report ===\n" + messages[0].content);
console.log("\n=== options ===\n" + JSON.stringify(messages[0].options));

// The default agent definition reclaims a reported child, so its terminal must
// leave the agents panel.
const address = /Terminal: (\S+)/.exec(messages[0].content)?.[1];
if (!address) throw new Error("report did not name a terminal");

let gone = false;
const reapDeadline = Date.now() + 20_000;
while (Date.now() < reapDeadline) {
	if ((await hcCode(["get", address, "--json"])) !== 0) {
		gone = true;
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!gone) {
	console.error(`FAIL: ${address} is still present after reporting`);
	process.exit(1);
}
console.log(`\nreclaimed: ${address} is gone`);
