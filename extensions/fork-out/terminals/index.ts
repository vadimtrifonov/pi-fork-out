import { herdr } from "./herdr.ts";
import { windowsTerminal } from "./windows-terminal.ts";

export type Destination = "pane" | "tab" | "window";

export interface LaunchRequest {
	sessionFile: string;
	cwd: string;
	destination: Destination;
}

export interface TerminalAdapter {
	isCurrent(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean;
	// Resolves after dispatch, not a guarantee that the launched program is ready.
	launch(request: LaunchRequest): Promise<void>;
}

export interface LaunchTarget {
	adapter: TerminalAdapter;
	destination: Destination;
}

// Herdr must win over a WT_SESSION inherited from an outer Windows Terminal.
const adapters = [herdr, windowsTerminal];

export function resolveTarget(
	args: string,
	platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): LaunchTarget {
	const destination = args.trim().toLowerCase() || "pane";
	if (destination === "window") {
		if (platform !== "win32") throw new Error("Opening a terminal window requires Windows Terminal on Windows");
		return { adapter: windowsTerminal, destination };
	}
	if (destination !== "pane" && destination !== "tab") {
		throw new Error("Use pane, tab, or window (default: pane)");
	}
	const adapter = adapters.find((candidate) => candidate.isCurrent(env, platform));
	if (!adapter) {
		throw new Error(platform === "win32"
			? "Run this command inside Herdr or Windows Terminal to create a pane or tab"
			: "Run this command inside Herdr to create a pane or tab");
	}
	return { adapter, destination };
}
