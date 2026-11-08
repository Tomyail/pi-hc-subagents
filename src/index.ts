import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeAgents, loadAgents, type AgentDef } from "./agents.ts";
import { hcGet, hcInterrupt, hcRead, hcReap, hcRm, hcRun, hcWaitChildren, isGone, isWorking, type HcTerminal } from "./hc.ts";
import { readLastAssistantText } from "./session.ts";

const SUBAGENT_TOOL = "subagent";
const KILL_TOOL = "subagent_kill";
const LIST_TOOL = "subagents_list";
const READ_TOOL = "subagent_read";
const INTERRUPT_TOOL = "subagent_interrupt";
/** `hc wait` checks in after this many seconds; a check-in is not a failure. */
const WAIT_TIMEOUT_SEC = 180;
/** hc wakes at once for a child that is alive but not working. Do not spin on it. */
const WAIT_MIN_GAP_MS = 1000;
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
	autoExit: boolean;
	finished: boolean;
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
		const { text, sessionFile } = readLastAssistantText(child.sessionDir);
		const elapsed = formatElapsed(Date.now() - child.startedMs);
		const exit = outcome.exitCode === undefined ? "" : `, exit ${outcome.exitCode}`;
		const header = `${child.title || child.name} (${child.agent}) — ${outcome.status}${exit}, ${elapsed}`;
		const body = text?.trim() || "(the child wrote no assistant message)";
		const terminalLine = child.autoExit ? `Terminal: ${child.address} (reclaimed)` : `Terminal: ${child.address}`;
		const content = `${header}\n\n${body}\n\n${terminalLine}${sessionFile ? `\nSession: ${sessionFile}` : ""}`;
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
		// A reported child is not worth a live process or a row in the agents panel.
		// `auto-exit: false` in an agent definition keeps it for a human to inspect.
		if (child.autoExit) await hcReap(child.address);
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
		// Still alive and not working: either it has not started yet, or it is idle
		// waiting for a human. A completed turn (turn > 0) proves the task ran, even
		// if no check happened to land mid-turn; before that, give startup a grace
		// window, then report.
		if (!child.sawWorking && !(terminal.turn ?? 0) && Date.now() - child.startedMs < STARTUP_GRACE_MS) return;
		await finish(child, { status: terminal.status?.state ?? "idle" });
	}

	let watching = false;

	/**
	 * One watcher for every child: `hc wait` reports news about any of them, so a
	 * loop per child would wake them all at once. A timeout is a check-in, not a
	 * failure, and is never reported to the parent.
	 */
	async function watch(): Promise<void> {
		if (watching) return;
		watching = true;
		try {
			while (children.size) {
				try {
					await hcWaitChildren(WAIT_TIMEOUT_SEC);
				} catch {
					// hc is unreachable: keep the loop alive without hammering it.
					await sleep(5000);
					continue;
				}
				// A timeout is a check-in, not news, and is never reported. Look at every
				// child anyway: one may have finished before this wait even started.
				const before = children.size;
				for (const child of [...children.values()]) {
					if (!child.finished) await tick(child);
				}
				if (children.size === before) await sleep(WAIT_MIN_GAP_MS);
			}
		} finally {
			watching = false;
		}
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
		const base = sanitizeName(spec.name ?? `${spec.agent}-${counter + 1}`);
		// Names are unique among live terminals, and a finished child stays live (pi
		// keeps its prompt after a turn), so a repeat launch has to step around it.
		let name = base;
		let sessionDir = "";
		let terminal: HcTerminal | undefined;
		for (let attempt = 0; !terminal; attempt += 1) {
			if (attempt > 20) throw new Error(`Could not find a free terminal name near "${base}".`);
			name = attempt === 0 ? base : `${base.slice(0, 28)}-${attempt + 1}`;
			sessionDir = join(homedir(), ".cache", "pi-hc-subagents", "sessions", name);
			mkdirSync(sessionDir, { recursive: true });
			const argv = childArgv(agent, { task: spec.task, model: spec.model, thinking: spec.thinking, sessionDir, parent });
			try {
				terminal = await hcRun(argv, {
					name,
					parent,
					cwd: ctx.cwd,
					labels: { "hc.subagent": "1", "hc.agent": spec.agent, "hc.title": spec.title ?? "" },
				});
			} catch (error) {
				if (!String(error).includes("name_taken")) throw error;
			}
		}
		if (!terminal) throw new Error(`Could not start a terminal for "${base}".`);
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
			autoExit: agent.autoExit,
			finished: false,
		};
		children.set(child.id, child);
		void watch();
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
			await hcReap(child.address);
			child.finished = true;
			children.delete(child.id);
			return {
				content: [{ type: "text" as const, text: `Stopped ${child.name} (${child.address}).` }],
				details: { id: child.id, terminal: child.address },
			};
		},
	});

	pi.registerTool({
		name: LIST_TOOL,
		label: "List subagents",
		description:
			"Show the sub-agents this session started, with the state herdr-core reports for each: state, status, how long it has held that status, and its turn count. " +
			"Use it to check whether a helper is still working, or to spot one that has been working for a long time.",
		promptSnippet: "Check on running helpers: state, status, time held in that status, turns. Cheap and immediate.",
		parameters: Type.Object({}),
		async execute() {
			const now = Date.now();
			const lines: string[] = [];
			const details: unknown[] = [];
			for (const child of children.values()) {
				const terminal = await hcGet(child.address).catch(() => undefined);
				const state = terminal?.state ?? "lost";
				const status = terminal?.status?.state ?? "-";
				// `status_ms` is when the status was set, so this is how long it has held it.
				// It does not move while a turn runs, so a long `working` here means either
				// a long turn or a stuck one; only reading the screen can tell them apart.
				const held = terminal?.status_ms ? now - terminal.status_ms : undefined;
				lines.push(
					`${child.name} (${child.agent}) ${child.address} — ${state}/${status}` +
						(held === undefined ? "" : ` for ${formatElapsed(held)}`) +
						`, up ${formatElapsed(now - child.startedMs)}, turn ${terminal?.turn ?? 0}` +
						(child.title ? ` — ${child.title}` : ""),
				);
				details.push({
					id: child.id,
					name: child.name,
					agent: child.agent,
					terminal: child.address,
					state,
					status,
					statusMs: terminal?.status_ms ?? null,
					turn: terminal?.turn ?? 0,
					elapsedMs: now - child.startedMs,
				});
			}
			if (!lines.length) {
				return { content: [{ type: "text" as const, text: "No sub-agents are running." }], details: { children: [] } };
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { children: details } };
		},
	});

	pi.registerTool({
		name: READ_TOOL,
		label: "Read subagent screen",
		description:
			"Print a sub-agent's terminal screen plus some history above it. Use it when a report is missing or unclear, or when a helper has been working a long time and you need to see where it is.",
		promptSnippet: "See what a helper's terminal shows right now: screen plus history.",
		parameters: Type.Object({
			name: Type.String({ description: "Sub-agent name or terminal address" }),
			lines: Type.Optional(Type.Number({ description: "Lines of history above the screen (default 40). While the child is working, hc returns only its screen." })),
		}),
		async execute(_toolCallId, params) {
			const child = findChild(params.name);
			if (!child) throw new Error(`No running sub-agent matches "${params.name}".`);
			const screen = (await hcRead(child.address, params.lines ?? 40)).trim();
			return {
				content: [{ type: "text" as const, text: `# ${child.name} (${child.address})\n\n${screen || "(the terminal shows nothing)"}` }],
				details: { id: child.id, terminal: child.address },
			};
		},
	});

	pi.registerTool({
		name: INTERRUPT_TOOL,
		label: "Interrupt subagent",
		description:
			"Press the stop key in a sub-agent's terminal: ends its current turn but does not kill the process. " +
			"Use it when a helper has been working too long. Unlike subagent_kill, a report still follows with whatever it had written.",
		promptSnippet: "Stop a helper's current turn without killing the terminal.",
		parameters: Type.Object({
			name: Type.String({ description: "Sub-agent name or terminal address" }),
		}),
		async execute(_toolCallId, params) {
			const child = findChild(params.name);
			if (!child) throw new Error(`No running sub-agent matches "${params.name}".`);
			const result = await hcInterrupt(child.address).catch((error: unknown) => ({ outcome: `failed: ${String(error)}` }));
			const outcome = result.outcome ?? "unknown";
			return {
				content: [
					{ type: "text" as const, text: `Interrupted ${child.name} (${child.address}): ${outcome}. A report follows with whatever it had written.` },
				],
				details: { id: child.id, terminal: child.address, outcome },
			};
		},
	});
}
