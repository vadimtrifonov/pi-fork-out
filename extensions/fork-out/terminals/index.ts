import { warp } from "./warp.ts";
import { windowsTerminal } from "./windows-terminal.ts";

export type Destination = "pane" | "tab" | "window";

export interface LaunchRequest {
	argv: readonly [string, ...string[]];
	cwd: string;
	destination: Destination;
}

export interface TerminalAdapter {
	name: string;
	platforms: readonly NodeJS.Platform[];
	destinations: readonly Destination[];
	defaultDestination: Destination;
	isCurrent(env: NodeJS.ProcessEnv): boolean;
	// Resolves after dispatch, not a guarantee that the launched program is ready.
	launch(request: LaunchRequest): Promise<void>;
}

export interface LaunchTarget {
	adapter: TerminalAdapter;
	destination: Destination;
}

// Warp must win over a WT_SESSION inherited from an outer Windows Terminal.
const adapters = [warp, windowsTerminal];

export function resolveTarget(
	args: string,
	platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): LaunchTarget {
	const requested = args.trim().toLowerCase();
	const adapter = adapters.find((candidate) => candidate.isCurrent(env))
		?? (platform === "win32" && requested === "window" ? windowsTerminal : undefined);
	if (!adapter) {
		throw new Error(platform === "win32"
			? "Run this command inside Windows Terminal or Warp to create a pane or tab"
			: "Run this command inside Warp on macOS, or Windows Terminal/Warp on Windows");
	}
	if (!adapter.platforms.includes(platform)) {
		throw new Error(`${adapter.name} launching is not supported on ${platform}`);
	}
	const destination = adapter.destinations.find((value) => value === (requested || adapter.defaultDestination));
	if (!destination) {
		throw new Error(`${adapter.name}: use ${adapter.destinations.join(" or ")} (default: ${adapter.defaultDestination})`);
	}
	return { adapter, destination };
}
