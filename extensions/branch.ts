import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DESTINATIONS = ["pane", "tab", "window"] as const;
type Destination = (typeof DESTINATIONS)[number];

function isDestination(value: string): value is Destination {
	return DESTINATIONS.includes(value as Destination);
}

function launchBranch(destination: Destination, cwd: string, sessionFile: string): Promise<void> {
	const action = destination === "pane" ? ["split-pane", "--vertical"] : ["new-tab"];
	const window = destination === "window" ? "new" : "0";
	const escapedSessionFile = sessionFile.replaceAll("'", "''");
	const command = `& pi --session '${escapedSessionFile}'`;
	const args = [
		"--window",
		window,
		...action,
		"--startingDirectory",
		cwd,
		"pwsh.exe",
		"-NoLogo",
		"-NoExit",
		"-Command",
		command,
	];

	return new Promise((resolve, reject) => {
		const child = spawn("wt.exe", args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("branch", {
		description: "Clone this session into a new Windows Terminal pane, tab, or window (default: pane)",
		handler: async (args, ctx) => {
			const destination = args.trim().toLowerCase() || "pane";
			if (!isDestination(destination)) {
				ctx.ui.notify("Usage: /branch [pane|tab|window]", "error");
				return;
			}
			if (process.platform !== "win32") {
				ctx.ui.notify("/branch currently supports Windows only", "error");
				return;
			}
			if (!process.env.WT_SESSION && destination !== "window") {
				ctx.ui.notify("Open pi inside Windows Terminal to create a pane or tab", "error");
				return;
			}

			await ctx.waitForIdle();

			const sessionFile = ctx.sessionManager.getSessionFile();
			const leafId = ctx.sessionManager.getLeafId();
			if (!sessionFile || !leafId || !existsSync(sessionFile)) {
				ctx.ui.notify("Nothing persisted yet; wait for the first response, then try again", "error");
				return;
			}

			try {
				const forkFile = SessionManager.open(sessionFile).createBranchedSession(leafId);
				if (!forkFile) throw new Error("Could not create the branched session");

				await launchBranch(destination, ctx.cwd, forkFile);
				ctx.ui.notify(`Opened branch in a new ${destination}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Branch failed: ${message}`, "error");
			}
		},
	});
}
