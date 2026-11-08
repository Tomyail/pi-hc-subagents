import { execFile } from "node:child_process";

/** The subset of a herdr-core terminal this extension needs. */
export type HcTerminal = {
	address: string;
	name: string | null;
	parent: string | null;
	state: string;
	status: { state: string; app?: string; msg?: string } | null;
	/** When `status` last changed. It does not move while a turn runs. */
	status_ms?: number | null;
	pid?: number | null;
	created_ms?: number;
	finished_ms?: number | null;
	title?: string;
	exit_code: number | null;
	reason: string | null;
	turn?: number;
	cwd?: string;
};

/** What `hc wait --children any` reports back. */
export type HcWait = {
	reason: string;
	ended: boolean;
	children: { terminal: string; ended: boolean; reason: string; exit_code: number | null }[];
};

type HcResult = { stdout: string; stderr: string; code: number };

function hc(args: string[], timeoutMs = 20_000): Promise<HcResult> {
	return new Promise((resolve) => {
		execFile("hc", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
			resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
		});
	});
}

async function hcJson<T>(args: string[], timeoutMs?: number): Promise<T> {
	const { stdout, stderr, code } = await hc(args, timeoutMs);
	if (code !== 0) {
		throw new Error(`hc ${args.join(" ")} failed: ${(stderr || stdout).trim() || `exit ${code}`}`);
	}
	try {
		return JSON.parse(stdout) as T;
	} catch {
		throw new Error(`hc ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
	}
}

export async function hcRun(
	argv: string[],
	options: { name: string; parent: string; cwd: string; labels?: Record<string, string> },
): Promise<HcTerminal> {
	const args = ["run", "--bg", "--json", "--no-notify", "--name", options.name, "--parent", options.parent, "--cwd", options.cwd];
	for (const [key, value] of Object.entries(options.labels ?? {})) {
		if (value) args.push("--label", `${key}=${value}`);
	}
	args.push("--", ...argv);
	return hcJson<HcTerminal>(args);
}

export async function hcGet(address: string): Promise<HcTerminal> {
	return hcJson<HcTerminal>(["get", address, "--json"]);
}

export async function hcKill(address: string): Promise<void> {
	await hcJson<unknown>(["kill", address, "--json"]);
}

/**
 * Wait until any child of this terminal has news, or `timeoutSec` passes.
 * `reason: "timeout"` is a check-in, not a failure: wait again.
 */
export async function hcWaitChildren(timeoutSec: number): Promise<HcWait> {
	return hcJson<HcWait>(
		["wait", "--children", "any", "--timeout", String(timeoutSec), "--json"],
		(timeoutSec + 20) * 1000,
	);
}

/** A terminal's screen plus `lines` of history above it. Plain text, not JSON. */
export async function hcRead(address: string, lines = 0): Promise<string> {
	const { stdout, stderr, code } = await hc(["read", address, "--lines", String(lines)]);
	if (code !== 0) throw new Error(`hc read ${address} failed: ${(stderr || stdout).trim() || `exit ${code}`}`);
	return stdout;
}

/** Press the stop key: ends the current turn, not the process. */
export async function hcInterrupt(address: string): Promise<{ key?: string; outcome?: string }> {
	return hcJson<{ key?: string; outcome?: string }>(["interrupt", address, "--json"]);
}

export async function hcRm(address: string): Promise<void> {
	await hcJson<unknown>(["rm", address, "--json"]);
}

/**
 * Stop a child and drop its terminal record. Best effort throughout: a child
 * that already exited only needs the record removed, and a slow shutdown must
 * never fail the report the parent is waiting for.
 */
export async function hcReap(address: string): Promise<void> {
	await hcKill(address).catch(() => {});
	for (let attempt = 0; attempt < 15; attempt += 1) {
		const terminal = await hcGet(address).catch(() => undefined);
		if (!terminal || isGone(terminal)) break;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	await hcRm(address).catch(() => {});
}

export function isWorking(terminal: HcTerminal): boolean {
	return terminal.state === "live" && terminal.status?.state === "working";
}

export function isGone(terminal: HcTerminal): boolean {
	return terminal.state !== "live";
}
