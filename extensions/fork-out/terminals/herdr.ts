import { execFile } from "node:child_process";
import type { TerminalAdapter } from "./index.ts";

type HerdrResult = {
	pane?: { pane_id?: string; workspace_id?: string };
	root_pane?: { pane_id?: string };
};

function run(args: string[]): Promise<string> {
	return new Promise<string>((resolve, reject) => {
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
}

async function query(args: string[]): Promise<HerdrResult> {
	return JSON.parse(await run(args)).result;
}

// Herdr panes run PowerShell by default on Windows and the user's Unix shell elsewhere.
function quote(value: string): string {
	// PowerShell also reads the typographic quotes U+2018 to U+201B as single quotes.
	if (process.platform === "win32") return `'${value.replace(/['\u2018-\u201b]/g, "$&$&")}'`;
	// Backslashes leave the quotes too: fish, unlike bash and zsh, reads them as escapes inside single quotes.
	return `'${value.replace(/['\\]/g, "'\\$&'")}'`;
}

export const herdr: TerminalAdapter = {
	isCurrent: (env) => env.HERDR_ENV === "1",
	async launch({ sessionFile, cwd, destination }) {
		// Without a caller ID, --current can target an unrelated focused pane.
		if (!process.env.HERDR_PANE_ID) {
			throw new Error("Herdr caller context is missing; run inside a Herdr pane");
		}
		// The path is typed into a shell, whose line editor would act on control characters.
		if (/[\x00-\x1f\x7f]/.test(sessionFile)) {
			throw new Error("Herdr: the session path cannot contain ASCII control characters.");
		}

		const isPane = destination === "right" || destination === "down";
		let created: HerdrResult;
		if (isPane) {
			created = await query(["pane", "split", "--current", "--direction", destination, "--cwd", cwd, "--focus"]);
		} else {
			// Resolve live caller context: inherited workspace IDs can be stale after a pane move.
			const current = await query(["pane", "current", "--current"]);
			const workspace = current.pane?.workspace_id;
			if (!workspace) throw new Error("Invalid Herdr response: missing caller workspace_id");
			created = await query(["tab", "create", "--workspace", workspace, "--cwd", cwd, "--focus"]);
		}
		const paneId = (isPane ? created.pane : created.root_pane)?.pane_id;
		if (!paneId) throw new Error("Invalid Herdr response: missing new pane_id");

		// `agent start` requires a name; a typed command leaves the fork unnamed, like a Pi started by hand.
		await run(["pane", "run", paneId, `pi --session ${quote(sessionFile)}`]);
	},
};
