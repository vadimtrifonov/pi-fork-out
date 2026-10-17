import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/fork-out/index.ts";
import { getPendingForkDraft } from "../extensions/fork-out/sessions.ts";
import type { LaunchRequest } from "../extensions/fork-out/terminals/index.ts";
import { herdr } from "../extensions/fork-out/terminals/herdr.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function harness(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "pi-fork-out-workflow-"));
	const source = SessionManager.create(root, join(root, "sessions"));
	const previousHerdr = process.env.HERDR_ENV;
	process.env.HERDR_ENV = "1";
	t.after(() => {
		if (previousHerdr === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previousHerdr;
		rmSync(root, { recursive: true, force: true });
	});
	const commands = new Map<string, Command>();
	const notifications: { message: string; level?: string }[] = [];
	let start!: (event: { type: "session_start" }, ctx: ExtensionCommandContext) => void | Promise<void>;
	const ui = {
		notify(message: string, level?: string) { notifications.push({ message, level }); },
		custom: t.mock.fn(async (): Promise<string | undefined> => undefined),
		setEditorText: t.mock.fn((_text: string) => {}),
	};
	extension({
		on(_event: string, handler: typeof start) { start = handler; },
		registerCommand(name: string, command: Command) { commands.set(name, command); },
		appendEntry(customType: string, data: unknown) { source.appendCustomEntry(customType, data); },
	} as unknown as ExtensionAPI);
	const ctx = { cwd: root, mode: "tui", sessionManager: source, ui } as unknown as ExtensionCommandContext;
	return { source, ctx, ui, commands, notifications, start: () => start({ type: "session_start" }, ctx) };
}

test("both commands complete only unfinished destinations", async (t) => {
	const h = harness(t);
	for (const name of ["clone-out", "fork-out"]) {
		const complete = h.commands.get(name)?.getArgumentCompletions;
		assert.ok(complete);
		const choices = await complete("");
		assert.ok(choices);
		assert.deepEqual(choices.map(({ value }) => value), ["right", "down", "tab", "window"]);
		assert.deepEqual(await complete("d"), [choices[1]]);
		assert.deepEqual(await complete("  RI"), [choices[0]]);
		for (const { value, label, description } of choices) {
			assert.equal(label, value);
			assert.ok(description?.trim());
			assert.equal(await complete(value), null);
			assert.equal(await complete(`  ${value.toUpperCase()}`), null);
		}
		for (const input of ["pane", "left", "up", "down ", "right down"]) {
			assert.equal(await complete(input), null);
		}
	}
});

test("clone-out opens a copy at the current position in a right-hand pane", async (t) => {
	const h = harness(t);
	h.source.appendMessage({ role: "user", content: "First prompt", timestamp: 1 });
	const leaf = h.source.appendMessage({ role: "user", content: "Second prompt", timestamp: 2 });
	const parentFile = h.source.getSessionFile()!;
	const original = readFileSync(parentFile, "utf8");
	const launch = t.mock.method(herdr, "launch", async (_request: LaunchRequest) => {});

	await h.commands.get("clone-out")!.handler("", h.ctx);

	assert.equal(launch.mock.callCount(), 1);
	const [request] = launch.mock.calls[0].arguments;
	assert.equal(request.cwd, h.ctx.cwd);
	assert.equal(request.destination, "right");
	assert.ok(existsSync(request.sessionFile));
	const copy = SessionManager.open(request.sessionFile);
	assert.equal(copy.getHeader()!.parentSession, parentFile);
	assert.equal(copy.getLeafId(), leaf);
	assert.equal(getPendingForkDraft(copy), undefined);
	assert.equal(h.ui.custom.mock.callCount(), 0);
	const notification = h.notifications.at(-1)!;
	assert.equal(notification.level, "info");
	assert.ok(notification.message.trim());
	assert.equal(h.source.getLeafId(), leaf);
	assert.equal(readFileSync(parentFile, "utf8"), original);
});

test("fork-out opens the selected history and draft at the requested destination", async (t) => {
	const h = harness(t);
	const first = h.source.appendMessage({ role: "user", content: "First prompt", timestamp: 1 });
	const selected = h.source.appendMessage({ role: "user", content: "Second prompt", timestamp: 2 });
	h.ui.custom.mock.mockImplementation(async () => selected);
	const parentFile = h.source.getSessionFile()!;
	const original = readFileSync(parentFile, "utf8");
	const launch = t.mock.method(herdr, "launch", async (_request: LaunchRequest) => {});

	await h.commands.get("fork-out")!.handler("down", h.ctx);

	assert.equal(launch.mock.callCount(), 1);
	const [request] = launch.mock.calls[0].arguments;
	assert.equal(request.cwd, h.ctx.cwd);
	assert.equal(request.destination, "down");
	assert.ok(existsSync(request.sessionFile));
	const copy = SessionManager.open(request.sessionFile);
	assert.equal(copy.getHeader()!.parentSession, parentFile);
	assert.ok(copy.getEntry(first));
	assert.equal(copy.getEntry(selected), undefined);
	assert.equal(getPendingForkDraft(copy)?.text, "Second prompt");
	const notification = h.notifications.at(-1)!;
	assert.equal(notification.level, "info");
	assert.ok(notification.message.trim());
	assert.equal(h.source.getLeafId(), selected);
	assert.equal(readFileSync(parentFile, "utf8"), original);
});

test("launch failure keeps the session copy and reports its path", async (t) => {
	const h = harness(t);
	h.source.appendMessage({ role: "user", content: "Prompt", timestamp: 1 });
	const launch = t.mock.method(herdr, "launch", async (_request: LaunchRequest) => {
		throw new Error("adapter failed");
	});

	await h.commands.get("clone-out")!.handler("", h.ctx);

	assert.equal(launch.mock.callCount(), 1);
	const { sessionFile } = launch.mock.calls[0].arguments[0];
	assert.ok(existsSync(sessionFile));
	assert.equal(SessionManager.open(sessionFile).getHeader()!.parentSession, h.source.getSessionFile());
	const notification = h.notifications.at(-1)!;
	assert.equal(notification.level, "error");
	assert.match(notification.message, /adapter failed/);
	assert.ok(notification.message.includes(sessionFile));
});

test("invalid destinations, cancelled selection, and non-interactive mode create no copies or launches", async (t) => {
	const h = harness(t);
	h.source.appendMessage({ role: "user", content: "Prompt", timestamp: 1 });
	const files = readdirSync(h.source.getSessionDir());
	const launch = t.mock.method(herdr, "launch", async () => {});
	await h.commands.get("fork-out")!.handler("invalid", h.ctx);
	assert.equal(h.ui.custom.mock.callCount(), 0);
	assert.equal(h.notifications.at(-1)!.level, "error");
	assert.match(h.notifications.at(-1)!.message, /\/fork-out/);
	await h.commands.get("fork-out")!.handler("tab", h.ctx);
	assert.equal(h.ui.custom.mock.callCount(), 1);
	h.ctx.mode = "rpc";
	await h.commands.get("clone-out")!.handler("tab", h.ctx);
	assert.match(h.notifications.at(-1)!.message, /requires interactive mode/);
	assert.equal(launch.mock.callCount(), 0);
	assert.deepEqual(readdirSync(h.source.getSessionDir()), files);
});

test("session startup restores the fork draft only once and only in the interactive editor", async (t) => {
	const h = harness(t);
	h.source.appendMessage({ role: "user", content: "Earlier prompt", timestamp: 1 });
	h.source.appendCustomEntry("pi-fork-out-fork-draft", { text: "Edit this prompt" });
	h.ctx.mode = "rpc";
	await h.start();
	assert.equal(h.ui.setEditorText.mock.callCount(), 0);
	assert.ok(getPendingForkDraft(h.source));
	h.ctx.mode = "tui";
	await h.start();
	assert.deepEqual(h.ui.setEditorText.mock.calls[0].arguments, ["Edit this prompt"]);
	h.ctx.sessionManager = SessionManager.open(h.source.getSessionFile()!);
	await h.start();
	assert.equal(h.ui.setEditorText.mock.callCount(), 1);
	assert.equal(getPendingForkDraft(h.ctx.sessionManager), undefined);
});
