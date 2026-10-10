import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { TerminalAdapter } from "./index.ts";

export function getWarpLocation(
	platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): { directory: string; scheme: string } {
	const scheme = env.WARP_FOCUS_URL?.split(":")[0] ?? "warp";
	if (scheme !== "warp" && scheme !== "warppreview") {
		throw new Error("Only Warp Stable and Preview are supported");
	}
	const preview = scheme === "warppreview";
	if (platform === "darwin") {
		return { directory: posix.join(home, preview ? ".warp-preview" : ".warp", "tab_configs"), scheme };
	}
	if (platform !== "win32") throw new Error("Warp launching supports Windows and macOS only");
	if (!env.APPDATA) throw new Error("APPDATA is not set; cannot locate Warp's Tab Config directory");
	return {
		directory: win32.join(env.APPDATA, "warp", preview ? "WarpPreview" : "Warp", "data", "tab_configs"),
		scheme,
	};
}

export function powershellStartup(cwd: string, configFile: string, argv: readonly string[]) {
	// shortcut: reject arguments mangled by legacy PowerShell; revisit if this launcher moves to PowerShell 7.
	if (argv.some((value) => value === "" || value.includes('"'))) {
		throw new Error("Warp's Windows PowerShell launcher cannot preserve empty arguments or embedded double quotes");
	}
	const quote = (value: string) => `'${value.replace(/['\u2018-\u201b]/g, "$&$&")}'`;
	const invocation = argv.map(quote).join(" ");
	return {
		shell: "powershell",
		command: `& { $ErrorActionPreference = 'Stop'; Set-Location -LiteralPath ${quote(cwd)}; Remove-Item -LiteralPath ${quote(configFile)}; & ${invocation} }`,
	};
}

export function zshStartup(cwd: string, configFile: string, argv: readonly string[]) {
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const invocation = argv.map(quote).join(" ");
	return {
		shell: "zsh",
		command: `cd -- ${quote(cwd)} && command rm -- ${quote(configFile)} && ${invocation}`,
	};
}

export function buildWarpConfig(
	platform: NodeJS.Platform,
	cwd: string,
	configFile: string,
	argv: readonly string[],
): string {
	// shortcut: reject Warp template delimiters in paths until literal templates are supported.
	if ([cwd, configFile, ...argv].some((value) => value.includes("{{"))) {
		throw new Error("Warp launch paths and arguments cannot contain '{{' (Tab Config template syntax)");
	}
	// Delete only after Warp has read the config and the shell has entered the project.
	const { shell, command } = platform === "win32"
		? powershellStartup(cwd, configFile, argv)
		: zshStartup(cwd, configFile, argv);
	const tomlString = (value: string) => JSON.stringify(value).replaceAll("\x7f", "\\u007f");
	return [
		'name = "Terminal session"',
		"[[panes]]",
		'id = "main"',
		'type = "terminal"',
		`shell = "${shell}"`,
		`directory = ${tomlString(cwd)}`,
		`commands = [${tomlString(command)}]`,
		"",
	].join("\n");
}

export const warp: TerminalAdapter = {
	name: "Warp",
	platforms: ["win32", "darwin"],
	destinations: ["tab", "window"],
	defaultDestination: "tab",
	isCurrent: (env) => env.TERM_PROGRAM === "WarpTerminal",
	async launch({ argv, cwd, destination }) {
		const { directory, scheme } = getWarpLocation();
		const name = `terminal_launch_${randomUUID()}`;
		const configFile = join(directory, `${name}.toml`);
		const config = buildWarpConfig(process.platform, cwd, configFile, argv);
		mkdirSync(directory, { recursive: true });
		writeFileSync(configFile, config, { encoding: "utf8", flag: "wx", mode: 0o600 });
		const uri = `${scheme}://tab_config/${name}${destination === "window" ? "?new_window=true" : ""}`;
		try {
			await new Promise<void>((resolve, reject) => {
				const command = process.platform === "win32" ? "powershell.exe" : "/usr/bin/open";
				const args = process.platform === "win32"
					? ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${uri}' -ErrorAction Stop`]
					: [uri];
				execFile(command, args, { windowsHide: true, timeout: 10_000 }, (error) => error ? reject(error) : resolve());
			});
			const deadline = Date.now() + 15_000;
			while (existsSync(configFile)) {
				if (Date.now() >= deadline) throw new Error("Warp did not run the startup command within 15 seconds");
				await setTimeout(100);
			}
		} finally {
			rmSync(configFile, { force: true });
		}
	},
};
