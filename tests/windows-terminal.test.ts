import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { windowsTerminal } from "../extensions/fork-out/terminals/windows-terminal.ts";

const request = { destination: "tab" as const, cwd: "project folder", sessionFile: "session path 'Ω & [brackets] $value.jsonl" };

function mockSpawn(t: TestContext, error?: Error) {
	const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
	const unref = t.mock.fn();
	t.mock.method(childProcess, "spawn", (command: string, args: string[], options: SpawnOptions) => {
		calls.push({ command, args, options });
		const child = Object.assign(new EventEmitter(), { unref });
		queueMicrotask(() => error ? child.emit("error", error) : child.emit("spawn"));
		return child;
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	return { calls, unref };
}

test("Windows Terminal launches each destination without inheriting Herdr context", async (t) => {
	const previousHerdr = process.env.HERDR_ENV;
	process.env.HERDR_ENV = "1";
	t.after(() => {
		if (previousHerdr === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previousHerdr;
	});
	const { calls, unref } = mockSpawn(t);
	const destinations = [
		{ destination: "right", args: ["--window", "0", "split-pane", "--vertical"], windowsHide: true },
		{ destination: "down", args: ["--window", "0", "split-pane", "--horizontal"], windowsHide: true },
		{ destination: "tab", args: ["--window", "0", "new-tab"], windowsHide: true },
		{ destination: "window", args: ["--window", "new", "new-tab"], windowsHide: false },
	] as const;
	for (const { destination, args, windowsHide } of destinations) {
		await windowsTerminal.launch({ ...request, destination });
		const call = calls.at(-1)!;
		assert.equal(call.command, "wt.exe");
		assert.deepEqual(call.args, [
			...args, "--startingDirectory", request.cwd,
			process.execPath, resolve(process.argv[1]), "--session", request.sessionFile,
		]);
		assert.equal(call.options.windowsHide, windowsHide);
		assert.equal(call.options.detached, true);
		assert.equal(call.options.stdio, "ignore");
		assert.ok(Object.keys(call.options.env!).every((key) => !key.toUpperCase().startsWith("HERDR_")));
		const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH")!;
		assert.equal(call.options.env![pathKey], process.env[pathKey]);
	}
	assert.equal(process.env.HERDR_ENV, "1", "Do not change the parent environment");
	assert.equal(unref.mock.callCount(), destinations.length);
});

test("Windows Terminal reports spawn failures", async (t) => {
	const { unref } = mockSpawn(t, new Error("spawn failed"));
	await assert.rejects(windowsTerminal.launch(request), /spawn failed/);
	assert.equal(unref.mock.callCount(), 0);
});

test("Windows Terminal rejects a missing Pi entrypoint before launching", (t) => {
	const { calls } = mockSpawn(t);
	const previousEntry = process.argv[1];
	t.after(() => { process.argv[1] = previousEntry; });
	process.argv[1] = join(tmpdir(), `pi-fork-out-missing-${randomUUID()}`, "cli.js");
	assert.throws(() => windowsTerminal.launch(request), {
		message: "The Pi CLI entrypoint is no longer available. Restart Pi and try again.",
	});
	assert.equal(calls.length, 0);
});
