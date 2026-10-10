import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { windowsTerminal } from "../extensions/fork-out/terminals/windows-terminal.ts";

test("Windows Terminal preserves destinations and passes through arbitrary unquoted argv", async (t) => {
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
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
	const argv = ["program path", "--probe", "argument 'Ω"] as const;
	for (const destination of ["pane", "tab", "window"] as const) {
		await windowsTerminal.launch({ destination, cwd: "project folder", argv });
		const call = calls.at(-1)!;
		assert.equal(call.command, "wt.exe");
		assert.deepEqual(call.args, [
			"--window", destination === "window" ? "new" : "0",
			...(destination === "pane" ? ["split-pane", "--vertical"] : ["new-tab"]),
			"--startingDirectory", "project folder", ...argv,
		]);
		assert.equal(call.options.windowsHide, destination !== "window");
		assert.equal(call.options.detached, true);
		assert.equal(call.options.stdio, "ignore");
	}
	assert.equal(unrefs, 3);
	fail = true;
	await assert.rejects(windowsTerminal.launch({ destination: "tab", cwd: ".", argv }), /spawn failed/);
	assert.equal(unrefs, 3);
});
