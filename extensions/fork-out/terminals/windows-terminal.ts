import { spawn } from "node:child_process";
import type { TerminalAdapter } from "./index.ts";

export const windowsTerminal: TerminalAdapter = {
	name: "Windows Terminal",
	platforms: ["win32"],
	destinations: ["pane", "tab", "window"],
	defaultDestination: "pane",
	isCurrent: (env) => Boolean(env.WT_SESSION),
	launch({ argv, cwd, destination }) {
		const action = destination === "pane" ? ["split-pane", "--vertical"] : ["new-tab"];
		const window = destination === "window" ? "new" : "0";
		const args = ["--window", window, ...action, "--startingDirectory", cwd, ...argv];
		return new Promise<void>((resolve, reject) => {
			const child = spawn("wt.exe", args, {
				detached: true,
				stdio: "ignore",
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
