import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One agent definition. v1 honours `description`, `model`, `thinking`, `tools`,
 * `spawning` and `auto-exit`; every other frontmatter key is ignored on purpose
 * so existing agent files load unchanged.
 */
export type AgentDef = {
	name: string;
	description: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	spawning: boolean;
	autoExit: boolean;
	source: string;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function unquote(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function parseFrontmatter(text: string): Record<string, string> {
	const match = FRONTMATTER.exec(text);
	if (!match) return {};
	const out: Record<string, string> = {};
	for (const rawLine of match[1].split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const key = line.slice(0, colon).trim();
		if (!key) continue;
		out[key] = unquote(line.slice(colon + 1));
	}
	return out;
}

function parseList(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const inner = value.replace(/^\[/, "").replace(/\]$/, "");
	const items = inner
		.split(",")
		.map((item) => unquote(item))
		.filter(Boolean);
	return items.length ? items : undefined;
}

export function agentDirs(cwd: string): string[] {
	return [join(cwd, ".pi", "agents"), join(homedir(), ".pi", "agent", "agents")];
}

function markdownFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => join(dir, file));
}

export function loadAgents(cwd: string): Map<string, AgentDef> {
	const agents = new Map<string, AgentDef>();
	for (const dir of agentDirs(cwd)) {
		for (const path of markdownFiles(dir)) {
			const frontmatter = parseFrontmatter(readFileSync(path, "utf8"));
			const name = path.slice(path.lastIndexOf("/") + 1, -".md".length);
			agents.set(name, {
				name,
				description: frontmatter.description ?? "",
				model: frontmatter.model || undefined,
				thinking: frontmatter.thinking || undefined,
				tools: parseList(frontmatter.tools),
				spawning: frontmatter.spawning !== "false",
				// Children are reclaimed by default: a finished helper is not worth a live
				// process or a row in the agents panel. `auto-exit: false` keeps it around
				// for a human to inspect.
				autoExit: frontmatter["auto-exit"] !== "false",
				source: path,
			});
		}
	}
	return agents;
}

export function describeAgents(agents: Map<string, AgentDef>): string {
	if (!agents.size) return "(no agent definitions found)";
	return [...agents.values()]
		.map((agent) => (agent.description ? `${agent.name} — ${agent.description}` : agent.name))
		.join("\n");
}
