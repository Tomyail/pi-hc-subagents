import { execFile } from "node:child_process";

/** The subset of a herdr-core terminal this extension needs. */
export type HcTerminal = {
	address: string;
	name: string | null;
	parent: string | null;
	state: string;
	status: { state: string; app?: string; msg?: string } | null;
	exit_code: number | null;
	reason: string | null;
	turn?: number;
	cwd?: string;
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

export async function hcRm(address: string): Promise<void> {
	await hcJson<unknown>(["rm", address, "--json"]);
}

export function isWorking(terminal: HcTerminal): boolean {
	return terminal.state === "live" && terminal.status?.state === "working";
}

export function isGone(terminal: HcTerminal): boolean {
	return terminal.state !== "live";
}
