import { execFile } from "node:child_process";
import type { TerminalAdapter } from "./index.ts";
import { getPiInvocation } from "./pi-command.ts";

// Pass data as argv, never interpolate it into AppleScript source.
const script = `on run argv
	tell application "Ghostty"
		set destination to item 1 of argv
		set launchConfiguration to new surface configuration
		set initial working directory of launchConfiguration to item 2 of argv
		if destination is "window" then
			set newWindow to new window with configuration launchConfiguration
			set newTerminal to focused terminal of selected tab of newWindow
		else
			set targetWindow to front window
			if targetWindow is missing value then error "Ghostty has no window to split or add a tab to"
			if destination is "tab" then
				set newTab to new tab in targetWindow with configuration launchConfiguration
				set newTerminal to focused terminal of newTab
			else
				set targetTerminal to focused terminal of selected tab of targetWindow
				if targetTerminal is missing value then error "Ghostty has no focused terminal to split"
				if destination is "right" then
					set newTerminal to split targetTerminal direction right with configuration launchConfiguration
				else
					set newTerminal to split targetTerminal direction down with configuration launchConfiguration
				end if
			end if
		end if
		-- Native initial input corrupts non-ASCII text in Ghostty 1.3.1; input text preserves UTF-8.
		input text (item 3 of argv) to newTerminal
		send key "enter" to newTerminal
	end tell
end run`;

function quote(value: string): string {
	return "'" + value.replaceAll("'", "'\\''") + "'";
}

export const ghostty: TerminalAdapter = {
	isCurrent: (env, platform) => platform === "darwin" && env.TERM_PROGRAM === "ghostty",
	launch({ sessionFile, cwd, destination }) {
		const command = [...getPiInvocation(), "--session", sessionFile].map(quote).join(" ");
		// Startup files may change directories; restore the session cwd before launching Pi.
		const input = `cd -- ${quote(cwd)} && ${command}`;
		// Ghostty paste processing rewrites control characters.
		if (/[\x00-\x1f\x7f]/.test(input)) {
			throw new Error("Ghostty: paths cannot contain ASCII control characters.");
		}
		// macOS canonical input holds 1,024 bytes; reserve one for Enter before the shell is ready.
		if (Buffer.byteLength(input, "utf8") > 1023) {
			throw new Error("Ghostty: launch command exceeds the 1,023-byte macOS terminal input limit.");
		}
		return new Promise<void>((resolve, reject) => {
			execFile("/usr/bin/osascript", ["-e", script, destination, cwd, input], {
				encoding: "utf8", timeout: 30_000,
			}, (error, _stdout, stderr) => {
				if (error) {
					reject(new Error(`Ghostty: ${stderr.trim() || error.message}\nRequires Ghostty 1.3+ with AppleScript enabled and macOS Automation permission.`));
				} else resolve();
			});
		});
	},
};
