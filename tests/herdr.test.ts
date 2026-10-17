import assert from "node:assert/strict";
import childProcess, { type ExecFileOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { herdr } from "../extensions/fork-out/terminals/herdr.ts";

type Reply = { stdout: string; stderr?: string; error?: Error };
const result = (value: unknown): Reply => ({ stdout: JSON.stringify({ result: value }) });
const paneCreated = result({ type: "pane_info", pane: { pane_id: "w2:p2" } });
const agentStarted = result({ type: "agent_started" });
const request = { destination: "right" as const, cwd: "project 'Ω & [brackets] $value", sessionFile: "session 'Ω & [brackets] $value.jsonl" };

function mockHerdr(t: TestContext, replies: Reply[]) {
	const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "stale-workspace", HERDR_BIN_PATH: "/tools/herdr binary" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	const calls: { command: string; args: string[] }[] = [];
	t.mock.method(childProcess, "execFile", (
		command: string, args: string[], options: ExecFileOptions,
		callback: (error: Error | null, stdout: string, stderr: string) => void,
	) => {
		calls.push({ command, args });
		assert.equal(options.windowsHide, true);
		assert.equal(options.timeout, 45_000);
		assert.equal(options.encoding, "utf8");
		assert.equal(options.shell, undefined);
		const reply = replies.shift();
		assert.ok(reply, `Unexpected Herdr call: ${args.join(" ")}`);
		queueMicrotask(() => callback(reply.error ?? null, reply.stdout, reply.stderr ?? ""));
	});
	syncBuiltinESMExports();
	return calls;
}

test("Herdr creates focused panes and tabs in the caller's context and preserves launch arguments", async (t) => {
	for (const destination of ["right", "down", "tab"] as const) {
		await t.test(destination, async (t) => {
			const isPane = destination !== "tab";
			const replies = isPane ? [paneCreated] : [
				result({ type: "pane_info", pane: { workspace_id: "w2" } }),
				result({ type: "tab_created", root_pane: { pane_id: "w2:p2" } }),
			];
			const calls = mockHerdr(t, [...replies, agentStarted]);
			await herdr.launch({ ...request, destination });
			assert.ok(calls.every(({ command }) => command === "/tools/herdr binary"));
			const creation = isPane ? [
				["pane", "split", "--current", "--direction", destination, "--cwd", request.cwd, "--focus"],
			] : [
				["pane", "current", "--current"],
				["tab", "create", "--workspace", "w2", "--cwd", request.cwd, "--focus"],
			];
			assert.deepEqual(calls.slice(0, -1).map(({ args }) => args), creation);
			const start = calls.at(-1)!.args;
			assert.match(start[2], /^[a-z][a-z0-9_-]{0,31}$/);
			assert.deepEqual(start, [
				"agent", "start", start[2], "--kind", "pi", "--pane", "w2:p2", "--", "--session", request.sessionFile,
			]);
			assert.equal(calls.length, creation.length + 1);
		});
	}
});

test("Herdr does not start an agent without a new pane ID", async (t) => {
	const calls = mockHerdr(t, [result({ type: "pane_info", pane: {} })]);
	await assert.rejects(herdr.launch(request), /missing new pane_id/);
	assert.equal(calls.length, 1);
});

test("Herdr reports CLI failures and retains created panes when startup is uncertain", async (t) => {
	for (const stage of ["create", "start"] as const) {
		await t.test(stage, async (t) => {
			const before = stage === "create" ? [] : [paneCreated];
			const calls = mockHerdr(t, [...before, {
				stdout: "", stderr: JSON.stringify({ error: { code: "timeout", message: "server timed out" } }),
				error: new Error("command failed"),
			}]);
			await assert.rejects(herdr.launch(request), {
				message: "server timed out" + (stage === "create" ? "" : "\nHerdr pane kept at: w2:p2"),
			});
			assert.equal(calls.length, before.length + 1);
		});
	}
	for (const [reply, message] of [
		[{ stdout: "", stderr: " herdr: cannot connect\n", error: new Error("command failed") }, "herdr: cannot connect"],
		[{ stdout: "", error: new Error("spawn herdr ENOENT") }, "spawn herdr ENOENT"],
	] as const) {
		await t.test(message, async (t) => {
			mockHerdr(t, [reply]);
			await assert.rejects(herdr.launch(request), { message });
		});
	}
});

test("Herdr requires caller context and falls back to the CLI on PATH", async (t) => {
	const calls = mockHerdr(t, [paneCreated, agentStarted]);
	delete process.env.HERDR_PANE_ID;
	await assert.rejects(herdr.launch(request), /caller context/);
	assert.equal(calls.length, 0);
	process.env.HERDR_PANE_ID = "w1:p1";
	delete process.env.HERDR_BIN_PATH;
	await herdr.launch(request);
	assert.ok(calls.every(({ command }) => command === "herdr"));
});
