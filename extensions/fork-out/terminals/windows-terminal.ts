import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { TerminalAdapter } from "./index.ts";

function getPiInvocation(): string[] {
	const piEntry = process.argv[1];
	if (piEntry) {
		const piCli = resolve(piEntry);
		if (existsSync(piCli)) return [process.execPath, piCli];

		// mise installations are versioned, so an update can remove this process's entrypoint.
		const normalizedEntry = piCli.replaceAll("\\", "/").toLowerCase();
		if (normalizedEntry.includes("/mise/installs/")) {
			return ["mise.exe", "exec", "--", "pi"];
		}
	}
	throw new Error("Could not locate the Pi CLI entrypoint");
}

export const windowsTerminal: TerminalAdapter = {
	isCurrent: (env, platform) => platform === "win32" && Boolean(env.WT_SESSION),
	launch({ sessionFile, cwd, destination }) {
		const action = destination === "pane" ? ["split-pane", "--vertical"] : ["new-tab"];
		const window = destination === "window" ? "new" : "0";
		const args = ["--window", window, ...action, "--startingDirectory", cwd, ...getPiInvocation(), "--session", sessionFile];
		return new Promise<void>((resolve, reject) => {
			const child = spawn("wt.exe", args, {
				detached: true,
				stdio: "ignore",
				// A Terminal child is outside Herdr and must not target its parent’s pane.
				env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("HERDR_"))),
				// SW_HIDE also hides a newly created Terminal window.
				windowsHide: destination !== "window",
			});
			child.once("error", reject);
			child.once("spawn", () => {
				child.unref();
				resolve();
			});
		});
	},
};
