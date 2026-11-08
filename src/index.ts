import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeAgents, loadAgents, type AgentDef } from "./agents.ts";
import { hcGet, hcKill, hcRm, hcRun, isGone, isWorking, type HcTerminal } from "./hc.ts";
import { readLastAssistantText } from "./session.ts";

const SUBAGENT_TOOL = "subagent";
const KILL_TOOL = "subagent_kill";
const POLL_MS = 2000;
const STARTUP_GRACE_MS = 90_000;
const CHILD_ENV = "PI_HC_SUBAGENT_CHILD";

type Child = {
	id: string;
	name: string;
	agent: string;
	title: string;
	task: string;
	address: string;
	sessionDir: string;
	startedMs: number;
	sawWorking: boolean;
	finished: boolean;
	timer?: ReturnType<typeof setInterval>;
};

type Outcome = { status: string; exitCode?: number };

/** Packages that also register a `subagent` tool. Loading both is not supported. */
function rivalPackages(): string[] {
	const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(settingsPath)) return [];
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown };
		if (!Array.isArray(settings.packages)) return [];
		return settings.packages
			.filter((entry): entry is string => typeof entry === "string")
			.filter((entry) => /subagents/i.test(entry) && !/pi-hc-subagents/i.test(entry));
	} catch {
		return [];
	}
}

function formatElapsed(ms: number): string {
	const total = Math.round(ms / 1000);
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function sanitizeName(raw: string): string {
	const cleaned = raw
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	return cleaned || "subagent";
}

function splitModel(model: string): { provider?: string; id: string } {
	const slash = model.indexOf("/");
	if (slash <= 0) return { id: model };
	return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

function childArgv(agent: AgentDef, options: { task: string; model?: string; thinking?: string; sessionDir: string; parent: string }): string[] {
	const argv = ["env", `${CHILD_ENV}=1`, `PI_HC_SUBAGENT_PARENT=${options.parent}`, "pi"];
	const model = options.model ?? agent.model;
	if (model) {
		const { provider, id } = splitModel(model);
		if (provider) argv.push("--provider", provider);
		argv.push("--model", id);
	}
	const thinking = options.thinking ?? agent.thinking;
	if (thinking) argv.push("--thinking", thinking);
	if (agent.tools?.length) argv.push("--tools", agent.tools.join(","));
	argv.push("--session-dir", options.sessionDir);
	if (!agent.spawning) {
		argv.push("--append-system-prompt", "You are a helper agent. Do not launch subagents; do the work yourself.");
	}
	argv.push(options.task);
	return argv;
}

export default function piHcSubagents(pi: ExtensionAPI) {
	// A child must never spawn grandchildren: the tool surface simply is not there.
	if (process.env[CHILD_ENV] === "1") return;

	const rivals = process.env.PI_HC_SUBAGENTS_SKIP_RIVAL_CHECK === "1" ? [] : rivalPackages();
	if (rivals.length) {
		throw new Error(
			`pi-hc-subagents cannot load: ${rivals.join(", ")} already provides a \`subagent\` tool. ` +
				`Remove it first (\`pi remove <source>\`), then reload.`,
		);
	}

	const children = new Map<string, Child>();
	let counter = 0;

	function nextId(): string {
		counter += 1;
		return `hcsub-${Date.now().toString(36)}-${counter}`;
	}

	function findChild(handle: string): Child | undefined {
		const direct = children.get(handle);
		if (direct) return direct;
		for (const child of children.values()) {
			if (child.name === handle || child.address === handle) return child;
		}
		return undefined;
	}

	async function finish(child: Child, outcome: Outcome): Promise<void> {
		if (child.finished) return;
		child.finished = true;
		if (child.timer) clearInterval(child.timer);
		const { text, sessionFile } = readLastAssistantText(child.sessionDir);
		const elapsed = formatElapsed(Date.now() - child.startedMs);
		const exit = outcome.exitCode === undefined ? "" : `, exit ${outcome.exitCode}`;
		const header = `${child.title || child.name} (${child.agent}) — ${outcome.status}${exit}, ${elapsed}`;
		const body = text?.trim() || "(the child wrote no assistant message)";
		const content = `${header}\n\n${body}\n\nTerminal: ${child.address}${sessionFile ? `\nSession: ${sessionFile}` : ""}`;
		pi.sendMessage(
			{
				customType: "hc_subagent_result",
				content,
				display: true,
				details: {
					id: child.id,
					name: child.name,
					agent: child.agent,
					terminal: child.address,
					task: child.task,
					status: outcome.status,
					exitCode: outcome.exitCode,
					elapsedMs: Date.now() - child.startedMs,
					sessionFile,
				},
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
		children.delete(child.id);
	}

	async function tick(child: Child): Promise<void> {
		if (child.finished) return;
		let terminal: HcTerminal;
		try {
			terminal = await hcGet(child.address);
		} catch {
			await finish(child, { status: "terminal lost" });
			return;
		}
		if (isWorking(terminal)) {
			child.sawWorking = true;
			return;
		}
		if (isGone(terminal)) {
			await hcRm(child.address).catch(() => {});
			await finish(child, { status: terminal.reason ?? "exited", exitCode: terminal.exit_code ?? undefined });
			return;
		}
		// Still alive and not working: either it has not started yet, or it is
		// idle waiting for a human. Give startup a grace window, then report.
		if (!child.sawWorking && Date.now() - child.startedMs < STARTUP_GRACE_MS) return;
		await finish(child, { status: terminal.status?.state ?? "idle" });
	}

	function watch(child: Child): void {
		child.timer = setInterval(() => {
			void tick(child);
		}, POLL_MS);
		child.timer.unref?.();
	}

	async function launch(
		ctx: ExtensionContext,
		spec: { agent: string; task: string; name?: string; title?: string; model?: string; thinking?: string },
	): Promise<Child> {
		const parent = process.env.HC_TERMINAL_ID;
		if (!parent) {
			throw new Error(
				"pi-hc-subagents needs herdr-core: run pi inside a herdr-app terminal so HC_TERMINAL_ID is set. " +
					"Without it there is no parent to attach the sub-agent to.",
			);
		}
		const agents = loadAgents(ctx.cwd);
		const agent = agents.get(spec.agent);
		if (!agent) {
			throw new Error(`Unknown agent "${spec.agent}".\n\nAvailable:\n${describeAgents(agents)}`);
		}
		const name = sanitizeName(spec.name ?? `${spec.agent}-${counter + 1}`);
		const sessionDir = join(homedir(), ".cache", "pi-hc-subagents", "sessions", name);
		mkdirSync(sessionDir, { recursive: true });
		const argv = childArgv(agent, { task: spec.task, model: spec.model, thinking: spec.thinking, sessionDir, parent });
		const terminal = await hcRun(argv, {
			name,
			parent,
			cwd: ctx.cwd,
			labels: { "hc.subagent": "1", "hc.agent": spec.agent, "hc.title": spec.title ?? "" },
		});
		const child: Child = {
			id: nextId(),
			name,
			agent: spec.agent,
			title: spec.title ?? "",
			task: spec.task,
			address: terminal.address,
			sessionDir,
			startedMs: Date.now(),
			sawWorking: false,
			finished: false,
		};
		children.set(child.id, child);
		watch(child);
		return child;
	}

	pi.registerTool({
		name: SUBAGENT_TOOL,
		label: "Subagent (herdr-core)",
		description:
			"Launch a named helper agent in a new herdr terminal, attached to this terminal as its child. " +
			"The call returns at once; the helper's report arrives later as a message that starts a new turn. " +
			"Agent definitions come from .pi/agents/*.md and ~/.pi/agent/agents/*.md.",
		promptSnippet:
			"Launch a helper agent in a herdr terminal. Returns immediately; the report arrives as a later message.\n" +
			"Do not poll or wait for it. Continue with independent work, or stop and let the report start the next turn.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent definition name, e.g. reviewer" }),
			task: Type.String({ description: "The work to hand over, written out in full" }),
			name: Type.Optional(Type.String({ description: "Machine handle for the terminal, lower-kebab, max 32 chars" })),
			title: Type.Optional(Type.String({ description: "Human-readable title shown in the report" })),
			model: Type.Optional(Type.String({ description: "Override the agent's model, e.g. provider/id" })),
			thinking: Type.Optional(Type.String({ description: "Override the agent's thinking level" })),
			children: Type.Optional(
				Type.Array(
					Type.Object({
						agent: Type.String({ description: "Agent definition name" }),
						task: Type.String({ description: "The work to hand over" }),
						name: Type.Optional(Type.String({ description: "Machine handle" })),
						title: Type.Optional(Type.String({ description: "Human-readable title" })),
						model: Type.Optional(Type.String({ description: "Model override" })),
						thinking: Type.Optional(Type.String({ description: "Thinking override" })),
					}),
					{ description: "Launch several helpers at once" },
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const specs = params.children?.length ? params.children : [{ agent: params.agent, task: params.task, name: params.name, title: params.title, model: params.model, thinking: params.thinking }];
			const launched: Child[] = [];
			for (const spec of specs) {
				launched.push(await launch(ctx, spec));
			}
			const lines = launched.map((child) => `Started ${child.name} (${child.agent}) in terminal ${child.address}.`);
			return {
				content: [{ type: "text" as const, text: `${lines.join("\n")}\n\nReports arrive as separate messages. Do not poll for them.` }],
				details: { children: launched.map((child) => ({ id: child.id, name: child.name, agent: child.agent, terminal: child.address })) },
			};
		},
	});

	pi.registerTool({
		name: KILL_TOOL,
		label: "Stop subagent",
		description: "Stop a running herdr sub-agent by name or terminal address. No report is delivered afterwards.",
		parameters: Type.Object({
			name: Type.String({ description: "Sub-agent name or terminal address" }),
		}),
		async execute(_toolCallId, params) {
			const child = findChild(params.name);
			if (!child) throw new Error(`No running sub-agent matches "${params.name}".`);
			await hcKill(child.address);
			child.finished = true;
			if (child.timer) clearInterval(child.timer);
			children.delete(child.id);
			return {
				content: [{ type: "text" as const, text: `Stopped ${child.name} (${child.address}).` }],
				details: { id: child.id, terminal: child.address },
			};
		},
	});
}
