import assert from "node:assert/strict";
import childProcess, { execFileSync, type ExecFileOptions } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ghostty } from "../extensions/fork-out/terminals/ghostty.ts";

const request = { destination: "right" as const, cwd: "project 'Ω & [brackets] $value", sessionFile: "session 'Ω & [brackets] $value.jsonl" };

function mockAppleScript(t: TestContext, error?: Error, stderr = "") {
	const calls: { command: string; args: string[] }[] = [];
	t.mock.method(childProcess, "execFile", (
		command: string, args: string[], options: ExecFileOptions,
		callback: (error: Error | null, stdout: string, stderr: string) => void,
	) => {
		calls.push({ command, args });
		assert.equal(options.encoding, "utf8");
		assert.equal(options.timeout, 30_000);
		assert.equal(options.shell, undefined);
		queueMicrotask(() => callback(error ?? null, "", stderr));
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	return calls;
}

test("Ghostty creates each destination and sends input to its new terminal in one dispatch", async (t) => {
	const calls = mockAppleScript(t);
	for (const destination of ["right", "down", "tab", "window"] as const) {
		await ghostty.launch({ ...request, destination });
		const call = calls.at(-1)!;
		assert.equal(call.command, "/usr/bin/osascript");
		assert.equal(call.args[0], "-e");
		const script = call.args[1];
		assert.match(script, /set newWindow to new window with configuration launchConfiguration/);
		assert.match(script, /set newTerminal to focused terminal of selected tab of newWindow/);
		assert.match(script, /set newTab to new tab in targetWindow with configuration launchConfiguration/);
		assert.match(script, /set newTerminal to focused terminal of newTab/);
		assert.match(script, /set newTerminal to split targetTerminal direction right with configuration launchConfiguration/);
		assert.match(script, /set newTerminal to split targetTerminal direction down with configuration launchConfiguration/);
		assert.match(script, /input text \(item 3 of argv\) to newTerminal\s+send key "enter" to newTerminal/);
		assert.doesNotMatch(script, /\b(?:delay|repeat|focus|activate)\b/);
		assert.ok(!script.includes(request.cwd) && !script.includes(request.sessionFile));
		assert.deepEqual(call.args.slice(2, 4), [destination, request.cwd]);
		assert.equal(call.args.length, 5);
	}
	assert.equal(calls.length, 4, "No retry can create a duplicate terminal");
});

test("Ghostty leaves shell startup and environment to its configuration", async (t) => {
	const calls = mockAppleScript(t);
	const previousEnv = process.env;
	t.after(() => { process.env = previousEnv; });
	process.env = { SHELL: "/caller/other-shell", OPENAI_API_KEY: "dummy-caller-secret", HERDR_ENV: "1" };
	await ghostty.launch(request);
	process.env = {};
	await ghostty.launch(request);
	assert.deepEqual(calls[0], calls[1]);
	assert.doesNotMatch(calls[0].args[1], /set (?:command|environment variables|initial input) of/);
	assert.ok(!calls[0].args.some(arg => arg.includes("dummy-caller-secret")));
});

test("Ghostty startup command restores cwd and quotes literal arguments in bash and zsh", { skip: process.platform === "win32" }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fork-out-ghostty-"));
	const cwd = join(dir, "project 'Ω 中文 😀 & [brackets] $value");
	mkdirSync(cwd);
	const entry = join(dir, "pi ' Ω $entry.cjs");
	writeFileSync(entry, "console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));");
	const previousEntry = process.argv[1];
	process.argv[1] = entry;
	t.after(() => { process.argv[1] = previousEntry; rmSync(dir, { recursive: true, force: true }); });
	const calls = mockAppleScript(t);
	const sessionFile = join(cwd, 'session "\\ \' ; $(exit 9) `exit 8` !literal.jsonl');
	await ghostty.launch({ ...request, cwd, sessionFile });
	for (const shell of ["/bin/bash", "/bin/zsh"]) {
		await t.test(shell, { skip: !existsSync(shell) }, () => {
			// Check shell syntax only; native input delivery requires a live Ghostty test.
			const flags = shell.endsWith("bash") ? ["--noprofile", "--norc", "-c"] : ["-f", "-c"];
			const actual = JSON.parse(execFileSync(shell, [...flags, calls[0].args[4]], { cwd: dir, encoding: "utf8" }));
			assert.deepEqual(actual, { args: ["--session", sessionFile], cwd: execFileSync("/bin/pwd", ["-P"], { cwd, encoding: "utf8" }).trim() });
		});
	}
});

test("Ghostty rejects control characters in paths before creating a terminal", (t) => {
	const calls = mockAppleScript(t);
	for (const invalid of [{ cwd: "project\tname" }, { sessionFile: "session\nname.jsonl" }, { sessionFile: "session\x1b\x7f.jsonl" }]) {
		assert.throws(() => ghostty.launch({ ...request, ...invalid }), {
			message: "Ghostty: paths cannot contain ASCII control characters.",
		});
	}
	assert.equal(calls.length, 0);
});

test("Ghostty reserves room for Enter within the macOS UTF-8 input limit", async (t) => {
	const calls = mockAppleScript(t);
	await ghostty.launch(request);
	const padding = 1023 - Buffer.byteLength(calls[0].args[4], "utf8");
	const sessionFile = request.sessionFile + "x".repeat(padding);
	await ghostty.launch({ ...request, sessionFile });
	assert.equal(Buffer.byteLength(calls[1].args[4], "utf8"), 1023);
	assert.throws(() => ghostty.launch({ ...request, sessionFile: sessionFile + "x" }), {
		message: "Ghostty: launch command exceeds the 1,023-byte macOS terminal input limit.",
	});
	assert.equal(calls.length, 2, "Oversized input must not create a terminal");
});

test("Ghostty reports AppleScript and process failures without retrying", async (t) => {
	for (const stderr of ["Ghostty scripting is disabled (-1708)", ""]) {
		await t.test(stderr || "process failure", async (t) => {
			const calls = mockAppleScript(t, new Error("osascript failed"), stderr);
			await assert.rejects(ghostty.launch(request), {
				message: `Ghostty: ${stderr || "osascript failed"}\nRequires Ghostty 1.3+ with AppleScript enabled and macOS Automation permission.`,
			});
			assert.equal(calls.length, 1);
		});
	}
});

test("Ghostty rejects a missing Pi entrypoint before launching", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fork-out-ghostty-"));
	const previousEntry = process.argv[1];
	t.after(() => { process.argv[1] = previousEntry; rmSync(dir, { recursive: true, force: true }); });
	const calls = mockAppleScript(t);
	process.argv[1] = join(dir, "missing-cli.js");
	assert.throws(() => ghostty.launch(request), {
		message: "The Pi CLI entrypoint is no longer available. Restart Pi and try again.",
	});
	assert.equal(calls.length, 0);
});
