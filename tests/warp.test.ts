import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildWarpConfig, getWarpLocation, powershellStartup, warp, zshStartup } from "../extensions/fork-out/terminals/warp.ts";

function temporaryDirectory(t: TestContext): string {
	const directory = mkdtempSync(join(os.tmpdir(), "pi-fork-out-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test("Warp Stable and Preview use matching config directories and URI schemes", () => {
	for (const preview of [false, true]) {
		const scheme = preview ? "warppreview" : "warp";
		const env = { APPDATA: "C:\\Users\\Test User\\AppData\\Roaming", WARP_FOCUS_URL: `${scheme}://session/parent` };
		assert.deepEqual(getWarpLocation("win32", env), {
			directory: `${env.APPDATA}\\warp\\${preview ? "WarpPreview" : "Warp"}\\data\\tab_configs`, scheme,
		});
		assert.deepEqual(getWarpLocation("darwin", env, "/Users/Test User"), {
			directory: `/Users/Test User/${preview ? ".warp-preview" : ".warp"}/tab_configs`, scheme,
		});
	}
	assert.equal(getWarpLocation("darwin", {}, "/Users/Test").scheme, "warp");
	assert.throws(() => getWarpLocation("win32", {}), /APPDATA/);
	assert.throws(() => getWarpLocation("darwin", { WARP_FOCUS_URL: "warpdev://session/parent" }), /Stable and Preview/);
});

test("configs serialize the selected shell startup and reject unsupported inputs", () => {
	const cwd = "/cwd 'Ω & [brackets] $value";
	const configFile = "/launch 'config.toml";
	const argv = ["program", "argument 'Ω\n$value\x7f"];
	for (const [platform, shell, startup] of [
		["win32", "powershell", powershellStartup],
		["darwin", "zsh", zshStartup],
	] as const) {
		const config = buildWarpConfig(platform, cwd, configFile, argv);
		assert.equal(config.match(/^shell = "(.+)"$/m)![1], shell);
		assert.equal(JSON.parse(config.match(/^directory = (.+)$/m)![1]), cwd);
		assert.deepEqual(JSON.parse(config.match(/^commands = (.+)$/m)![1]), [startup(cwd, configFile, argv).command]);
	}
	for (let index = 0; index < 4; index++) {
		const values = ["/cwd", "/config", "/program", "argument"];
		values[index] += "{{name}}";
		assert.throws(() => buildWarpConfig("darwin", values[0], values[1], values.slice(2)), /template syntax/);
	}
	for (const argument of ["", 'embedded "quote"']) {
		assert.throws(() => powershellStartup("/cwd", "/config", ["program", argument]), /cannot preserve/);
	}
});

for (const [platform, startup] of [["win32", powershellStartup], ["darwin", zshStartup]] as const) {
	const shell = platform === "win32" ? "powershell.exe" : "zsh";
	test(`${platform} startup preserves shell state and argv and refuses missing directories or cancelled launches`, {
		skip: platform === "win32" ? process.platform !== "win32" : childProcess.spawnSync(shell, ["--version"]).status !== 0,
	}, (t) => {
		const root = temporaryDirectory(t);
		const cwd = join(root, "cwd 'Ω & [brackets] $value `tick ’smart‘");
		mkdirSync(cwd);
		const configFile = join(root, "launch 'config.toml");
		const keep = join(root, "keep.toml");
		const marker = join(root, "result.json");
		const script = join(root, "fixture.cjs");
		writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));`);
		writeFileSync(keep, "keep");
		const argument = "argument ' $value `tick ; & Ω ‘ ’ ‚ ‛" + (platform === "darwin" ? ' "quoted" | \n' : "");
		const shellPath = (path: string) => platform === "darwin" ? path.replaceAll("\\", "/") : path;
		const args = ["--probe", argument, ...(platform === "darwin" ? [""] : [])];
		const argv = ["node", shellPath(script), ...args];
		writeFileSync(configFile, "launch config");
		const { command } = startup(shellPath(cwd), shellPath(configFile), argv);
		const run = (command: string) => {
			const result = childProcess.spawnSync(shell, platform === "win32"
				? ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Continue'; try { ${command} } finally { Write-Output $ErrorActionPreference; Write-Output ((Get-Location).ProviderPath -eq $env:FORK_OUT_TEST_CWD) }`]
				: ["-f", "-c", `alias rm='rm -i'\n${command}`],
				{ encoding: "utf8", env: { ...process.env, FORK_OUT_TEST_CWD: cwd } });
			assert.ifError(result.error);
			if (platform === "win32") assert.equal(result.stdout.split(/\r?\n/)[0], "Continue", "Do not change the parent shell's error preference");
			return result;
		};
		const started = run(command);
		assert.equal(started.status, 0, started.stderr);
		if (platform === "win32") assert.equal(started.stdout.split(/\r?\n/)[1], "True", "Keep the project directory after the program exits");
		assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { cwd, args });
		assert.ok(!existsSync(configFile));
		assert.equal(readFileSync(keep, "utf8"), "keep");

		rmSync(marker);
		const cancelled = run(command);
		assert.notEqual(cancelled.status, 0);
		assert.ok(!existsSync(marker), "Do not start a program after its launch config has been removed");

		const missingDirectory = startup(shellPath(join(root, "missing")), shellPath(configFile), argv);
		writeFileSync(configFile, "launch config");
		const failed = run(missingDirectory.command);
		assert.notEqual(failed.status, 0);
		assert.ok(existsSync(configFile));
		assert.ok(!existsSync(marker), "Do not start a program in the wrong directory");
	});
}

test("Warp routes URIs and cleans configs on success, opener failure, and timeout without deleting command arguments", {
	skip: process.platform !== "win32" && process.platform !== "darwin",
}, async (t) => {
	const root = temporaryDirectory(t);
	const previousAppData = process.env.APPDATA;
	const previousFocus = process.env.WARP_FOCUS_URL;
	process.env.APPDATA = root;
	process.env.WARP_FOCUS_URL = "warppreview://session/parent";
	t.after(() => {
		if (previousAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousAppData;
		if (previousFocus === undefined) delete process.env.WARP_FOCUS_URL; else process.env.WARP_FOCUS_URL = previousFocus;
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	t.mock.method(os, "homedir", () => root);
	let outcome: "success" | "error" | "timeout" = "success";
	const uris: string[] = [];
	t.mock.method(childProcess, "execFile", (command: string, args: string[], _options: unknown, callback: (error: Error | null) => void) => {
		assert.equal(command, process.platform === "win32" ? "powershell.exe" : "/usr/bin/open");
		const uri = args.at(-1)!.match(/warppreview:\/\/tab_config\/terminal_launch_[a-f0-9-]+(?:\?new_window=true)?/)![0];
		uris.push(uri);
		const files = readdirSync(getWarpLocation().directory);
		assert.equal(files.length, 1);
		if (outcome === "success") rmSync(join(getWarpLocation().directory, files[0]));
		callback(outcome === "error" ? new Error("opener failed") : null);
	});
	syncBuiltinESMExports();
	const file = join(root, "input.txt");
	writeFileSync(file, "preserved input");
	const argv = ["program", "--input", file] as const;
	for (const destination of ["tab", "window"] as const) {
		await warp.launch({ destination, cwd: root, argv });
		assert.equal(uris.at(-1)!.endsWith("?new_window=true"), destination === "window");
	}
	outcome = "error";
	await assert.rejects(warp.launch({ destination: "tab", cwd: root, argv }), /opener failed/);
	assert.deepEqual(readdirSync(getWarpLocation().directory), []);
	outcome = "timeout";
	let now = 0;
	t.mock.method(Date, "now", () => now += 20_000);
	await assert.rejects(warp.launch({ destination: "tab", cwd: root, argv }), /startup command within 15 seconds/);
	assert.deepEqual(readdirSync(getWarpLocation().directory), []);
	assert.equal(readFileSync(file, "utf8"), "preserved input");
});
