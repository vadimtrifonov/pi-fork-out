import { ghostty } from "./ghostty.ts";
import { herdr } from "./herdr.ts";
import { windowsTerminal } from "./windows-terminal.ts";

export type Destination = "right" | "down" | "tab" | "window";

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

// Herdr owns panes and tabs even when an outer terminal's environment is inherited.
const adapters = [herdr, ghostty, windowsTerminal];

export function resolveTarget(
	args: string,
	platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): LaunchTarget {
	const destination = args.trim().toLowerCase() || "right";
	if (destination === "window") {
		if (platform === "win32") return { adapter: windowsTerminal, destination };
		if (platform === "darwin") return { adapter: ghostty, destination };
		throw new Error("Opening a terminal window requires Ghostty on macOS or Windows Terminal on Windows");
	}
	if (destination !== "right" && destination !== "down" && destination !== "tab") {
		throw new Error("Use right, down, tab, or window (default: right)");
	}
	const adapter = adapters.find((candidate) => candidate.isCurrent(env, platform));
	if (!adapter) {
		throw new Error(platform === "win32"
			? "Run this command inside Herdr or Windows Terminal to create a pane or tab"
			: platform === "darwin" ? "Run this command inside Herdr or Ghostty to create a pane or tab"
			: "Run this command inside Herdr to create a pane or tab");
	}
	return { adapter, destination };
}
