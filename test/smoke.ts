/**
 * End-to-end smoke test. Run from a herdr-app terminal:
 *
 *   node test/smoke.ts
 *
 * Launches a real child through hc, waits for its report, and prints what the
 * parent would have received. Requires `hc` and HC_TERMINAL_ID.
 */
import piHcSubagents from "../src/index.ts";

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
