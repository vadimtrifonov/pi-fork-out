import { spawn } from "node:child_process";
import type { TerminalAdapter } from "./index.ts";
import { getPiInvocation } from "./pi-command.ts";

export const windowsTerminal: TerminalAdapter = {
	isCurrent: (env, platform) => platform === "win32" && Boolean(env.WT_SESSION),
	launch({ sessionFile, cwd, destination }) {
		const action = destination === "right" ? ["split-pane", "--vertical"]
			: destination === "down" ? ["split-pane", "--horizontal"] : ["new-tab"];
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
