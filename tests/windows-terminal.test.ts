import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { windowsTerminal } from "../extensions/fork-out/terminals/windows-terminal.ts";

test("Windows Terminal preserves the Pi invocation and paths without leaking Herdr context", async (t) => {
	const previousHerdr = process.env.HERDR_ENV;
	process.env.HERDR_ENV = "1";
	t.after(() => {
		if (previousHerdr === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previousHerdr;
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
	let fail = false;
	let unrefs = 0;
	t.mock.method(childProcess, "spawn", (command: string, args: string[], options: SpawnOptions) => {
		calls.push({ command, args, options });
		const child = Object.assign(new EventEmitter(), { unref() { unrefs++; } });
		queueMicrotask(() => fail ? child.emit("error", new Error("spawn failed")) : child.emit("spawn"));
		return child;
	});
	syncBuiltinESMExports();
	const sessionFile = "session path 'Ω & [brackets] $value.jsonl";
	for (const destination of ["pane", "tab", "window"] as const) {
		await windowsTerminal.launch({ destination, cwd: "project folder", sessionFile });
		const call = calls.at(-1)!;
		assert.equal(call.command, "wt.exe");
		assert.deepEqual(call.args, [
			"--window", destination === "window" ? "new" : "0",
			...(destination === "pane" ? ["split-pane", "--vertical"] : ["new-tab"]),
			"--startingDirectory", "project folder", process.execPath, resolve(process.argv[1]), "--session", sessionFile,
		]);
		assert.equal(call.options.windowsHide, destination !== "window");
		assert.equal(call.options.detached, true);
		assert.equal(call.options.stdio, "ignore");
		assert.ok(Object.keys(call.options.env!).every((key) => !key.toUpperCase().startsWith("HERDR_")));
		const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH")!;
		assert.equal(call.options.env![pathKey], process.env[pathKey]);
		assert.equal(process.env.HERDR_ENV, "1", "Do not change the parent environment");
	}
	assert.equal(unrefs, 3);
	fail = true;
	await assert.rejects(windowsTerminal.launch({ destination: "tab", cwd: ".", sessionFile }), /spawn failed/);
	assert.equal(unrefs, 3);

	const previousEntry = process.argv[1];
	t.after(() => { process.argv[1] = previousEntry; });
	const missing = join(tmpdir(), `pi-fork-out-missing-${randomUUID()}`);
	process.argv[1] = join(missing, "mise", "installs", "pi", "cli.js");
	fail = false;
	await windowsTerminal.launch({ destination: "window", cwd: ".", sessionFile });
	assert.deepEqual(calls.at(-1)!.args.slice(5), ["mise.exe", "exec", "--", "pi", "--session", sessionFile]);
	process.argv[1] = join(missing, "unknown", "cli.js");
	const callCount = calls.length;
	assert.throws(() => windowsTerminal.launch({ destination: "window", cwd: ".", sessionFile }), /Could not locate the Pi CLI/);
	assert.equal(calls.length, callCount);
});
