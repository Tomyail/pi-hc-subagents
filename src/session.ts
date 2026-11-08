import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type SessionEntry = {
	type?: string;
	message?: { role?: string; content?: unknown };
};

function newestSessionFile(sessionDir: string): string | undefined {
	if (!existsSync(sessionDir)) return undefined;
	const files = readdirSync(sessionDir)
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => join(sessionDir, file))
		.filter((path) => {
			try {
				return statSync(path).isFile();
			} catch {
				return false;
			}
		});
	if (!files.length) return undefined;
	files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	return files[0];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (item && typeof item === "object" && (item as { type?: string }).type === "text") {
			const text = (item as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) parts.push(text);
		}
	}
	return parts.join("\n\n");
}

/**
 * The child's report: the last assistant message it wrote. `subagent_done` is not
 * registered for auto-exit children, so the session file is the one source that
 * works for every completion path.
 */
export function readLastAssistantText(sessionDir: string): { text?: string; sessionFile?: string } {
	const sessionFile = newestSessionFile(sessionDir);
	if (!sessionFile) return {};
	let last: string | undefined;
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: SessionEntry;
		try {
			entry = JSON.parse(trimmed) as SessionEntry;
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		if (entry.message?.role !== "assistant") continue;
		const text = textOf(entry.message.content);
		if (text.trim()) last = text;
	}
	return { text: last, sessionFile };
}
