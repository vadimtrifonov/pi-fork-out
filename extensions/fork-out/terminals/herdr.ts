import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { TerminalAdapter } from "./index.ts";

type HerdrResult = {
	pane?: { pane_id?: string; workspace_id?: string };
	root_pane?: { pane_id?: string };
};

async function run(args: string[]): Promise<HerdrResult> {
	const stdout = await new Promise<string>((resolve, reject) => {
		execFile(process.env.HERDR_BIN_PATH || "herdr", args, {
			encoding: "utf8", windowsHide: true, timeout: 45_000,
		}, (error, stdout, stderr) => {
			if (error) {
				let message = stderr.trim() || error.message;
				try {
					const detail = JSON.parse(message)?.error?.message;
					if (typeof detail === "string" && detail) message = detail;
				} catch { /* Keep plain-text CLI and process errors. */ }
				reject(new Error(message));
			} else resolve(stdout);
		});
	});
	return JSON.parse(stdout).result;
}

export const herdr: TerminalAdapter = {
	isCurrent: (env) => env.HERDR_ENV === "1",
	async launch({ sessionFile, cwd, destination }) {
		// Without a caller ID, --current can target an unrelated focused pane.
		if (!process.env.HERDR_PANE_ID) {
			throw new Error("Herdr caller context is missing; run inside a Herdr pane");
		}

		let created: HerdrResult;
		if (destination === "pane") {
			created = await run(["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--no-focus"]);
		} else {
			// Resolve live caller context: inherited workspace IDs can be stale after a pane move.
			const current = await run(["pane", "current", "--current"]);
			const workspace = current.pane?.workspace_id;
			if (!workspace) throw new Error("Invalid Herdr response: missing caller workspace_id");
			created = await run(["tab", "create", "--workspace", workspace, "--cwd", cwd, "--no-focus"]);
		}
		const paneId = (destination === "pane" ? created.pane : created.root_pane)?.pane_id;
		if (!paneId) throw new Error("Invalid Herdr response: missing new pane_id");

		try {
			await run([
				"agent", "start", `pi-fork-${randomUUID().slice(0, 12)}`, "--kind", "pi", "--pane", paneId,
				"--", "--session", sessionFile,
			]);
			await run(["agent", "focus", paneId]);
		} catch (error) {
			// A timeout can arrive after Pi starts; keep the pane and session for recovery.
			throw new Error(`${error instanceof Error ? error.message : String(error)}\nHerdr pane kept at: ${paneId}`);
		}
	},
};
