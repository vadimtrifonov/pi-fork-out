import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/fork-out/index.ts";
import { getPendingForkDraft } from "../extensions/fork-out/sessions.ts";
import type { LaunchRequest } from "../extensions/fork-out/terminals/index.ts";
import { warp } from "../extensions/fork-out/terminals/warp.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function harness(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "pi-fork-out-workflow-"));
	const source = SessionManager.create(root, join(root, "sessions"));
	const previousTerm = process.env.TERM_PROGRAM;
	process.env.TERM_PROGRAM = "WarpTerminal";
	t.after(() => {
		if (previousTerm === undefined) delete process.env.TERM_PROGRAM; else process.env.TERM_PROGRAM = previousTerm;
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

const supportedHost = process.platform === "win32" || process.platform === "darwin";

test("commands prepare Pi argv, delegate launching, and preserve copies on adapter failure", { skip: !supportedHost }, async (t) => {
	const h = harness(t);
	h.source.appendMessage({ role: "user", content: "First prompt", timestamp: 1 });
	const selected = h.source.appendMessage({ role: "user", content: "Second prompt", timestamp: 2 });
	h.ui.custom.mock.mockImplementation(async () => selected);
	const parentFile = h.source.getSessionFile()!;
	const original = readFileSync(parentFile, "utf8");
	const requests: LaunchRequest[] = [];
	let fail = false;
	t.mock.method(warp, "launch", async (request: LaunchRequest) => {
		requests.push(request);
		if (fail) throw new Error("adapter failed");
	});

	for (const failure of [false, true]) {
		fail = failure;
		for (const command of ["clone-out", "fork-out"]) {
			await h.commands.get(command)!.handler("", h.ctx);
			const request = requests.at(-1)!;
			const file = request.argv.at(-1)!;
			assert.deepEqual(request.argv, [process.execPath, resolve(process.argv[1]), "--session", file]);
			assert.equal(request.cwd, h.ctx.cwd);
			assert.equal(request.destination, "tab");
			assert.ok(existsSync(file));
			const copy = SessionManager.open(file);
			assert.equal(copy.getHeader()!.parentSession, parentFile);
			assert.equal(getPendingForkDraft(copy)?.text, command === "fork-out" ? "Second prompt" : undefined);
			assert.equal(copy.getEntry(selected) !== undefined, command === "clone-out");
			const notification = h.notifications.at(-1)!;
			assert.equal(notification.level, failure ? "error" : "info");
			if (failure) {
				assert.match(notification.message, /adapter failed/);
				assert.ok(notification.message.endsWith(`Session copy kept at: ${file}`));
			}
		}
	}
	assert.equal(requests.length, 4);
	assert.equal(h.source.getLeafId(), selected);
	assert.equal(readFileSync(parentFile, "utf8"), original);
});

test("invalid destinations, cancelled selection, and non-interactive mode create no copies or launches", { skip: !supportedHost }, async (t) => {
	const h = harness(t);
	h.source.appendMessage({ role: "user", content: "Prompt", timestamp: 1 });
	const files = readdirSync(h.source.getSessionDir());
	const launch = t.mock.method(warp, "launch", async () => {});
	await h.commands.get("fork-out")!.handler("pane", h.ctx);
	assert.equal(h.ui.custom.mock.callCount(), 0);
	assert.match(h.notifications.at(-1)!.message, /tab or window/);
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
