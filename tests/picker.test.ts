import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test, type TestContext } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme, SessionManager, TreeSelectorComponent, type ExtensionCommandContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, setKeybindings, TuiAltScreen, visibleWidth, type Component, type Focusable, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { selectForkEntry } from "../extensions/fork-out/picker.ts";
import { assistantMessage } from "./fixtures.ts";

type CustomFactory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];
initTheme("dark", false);

// Pi's application bindings are not exported as a runtime value at the package root.
const { KeybindingsManager: PiKeybindingsManager } = await import(
	new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
) as { KeybindingsManager: new () => KeybindingsManager };
const keybindings = new PiKeybindingsManager();
setKeybindings(keybindings);

function picker(t: TestContext, messages: (string | AssistantMessage)[] | SessionManager, rows = 60, host?: TuiAltScreen) {
	const source = messages instanceof SessionManager ? messages : SessionManager.inMemory();
	if (Array.isArray(messages)) {
		for (const message of messages) source.appendMessage(typeof message === "string" ? { role: "user", content: message, timestamp: 1 } : message);
	}
	const entries = source.getBranch();
	const tui = { terminal: { rows }, requestRender: t.mock.fn() };
	const fg = t.mock.fn((_color: string, text: string) => text);
	const theme = { fg, bold: (text: string) => text } as unknown as Theme;
	let component!: Component & Focusable;
	const ctx = {
		sessionManager: source,
		ui: {
			custom(factory: CustomFactory, options: Parameters<ExtensionCommandContext["ui"]["custom"]>[1]) {
				assert.equal(options?.overlay, undefined, "the picker uses Pi's inline custom UI");
				return new Promise<unknown>((done) => {
					component = factory((host ?? tui) as TUI, theme, keybindings, done) as Component & Focusable;
					// Mount for terminal input routing, not to simulate Pi's dialog lifecycle.
					if (host) {
						host.addChild(component);
						host.setFocus(component);
					}
				});
			},
		},
	} as unknown as ExtensionCommandContext;
	const selection = selectForkEntry(ctx, entries);
	component.focused = true;
	const render = (width = 80) => component.render(width).map(stripVTControlCharacters);
	return {
		component, source, entries, selection, tui, fg, render,
		type(text: string) {
			for (const character of text) component.handleInput!(character);
		},
		preview(width = 80) {
			const lines = render(width);
			const end = lines.length - (tui.terminal.rows < 32 ? 1 : 2);
			return lines.slice(end - 3, end).map((line) => line.trimEnd().replace(/^ {2}/, ""));
		},
	};
}

test("the muted preview follows selection without changing the original entry", async (t) => {
	const original = "\x1b[31mFirst line\x1b[0m\r\n\tSecond line\nThird line\nFourth line";
	const h = picker(t, [original, "Latest message"]);
	const entries = structuredClone(h.entries);
	assert.deepEqual(h.preview(), ["Latest message", "", ""]);
	assert.ok(h.render().some((line) => line.includes("› • user: Latest message")));
	assert.ok(h.fg.mock.calls.some(({ arguments: [color, text] }) => color === "muted" && text === "Latest message"));
	h.component.handleInput!("\x1b[A");
	assert.deepEqual(h.preview(), ["First line Second line Third line Fourth line", "", ""]);
	assert.equal(h.tui.requestRender.mock.callCount(), 1);
	h.component.handleInput!("\r");
	assert.equal(await h.selection, h.entries[0]);
	assert.deepEqual(h.entries, entries);
});

test("mixed choices retain native role labels and preview only the assistant reply text", async (t) => {
	const reply = assistantMessage("", {
		content: [
			{ type: "thinking", thinking: "Private reasoning" },
			{ type: "text", text: "\x1b[32mReview complete\x1b[0m\nFirst finding\nSecond finding" },
			{ type: "text", text: "More details" },
		],
	});
	const h = picker(t, ["Review this change", assistantMessage("Still checking", { stopReason: "toolUse" }), reply]);
	const entries = structuredClone(h.source.getEntries());
	assert.ok(h.render().some((line) => line.includes("user: Review this change")));
	assert.ok(h.render().some((line) => line.includes("assistant: Review complete")));
	assert.ok(h.render().some((line) => line.includes("Still checking")));
	assert.ok(!h.render().some((line) => line.includes("Private reasoning")));
	assert.deepEqual(h.preview(), ["Review complete First finding Second finding More details", "", ""]);
	h.type("Review complete");
	assert.ok(h.render().some((line) => line.includes("(1/1)")));
	h.component.handleInput!("\r");
	assert.equal(await h.selection, h.entries[2]);
	assert.deepEqual(h.source.getEntries(), entries);
});

test("formatted replies fill the preview with reflowed content in both layouts", async (t) => {
	const reply = [
		"# Summary", "", "**Implemented** the compact preview.", "", "",
		"- Removed blank lines and indentation.", "- Reflowed text across all three rows.", "",
		"> More useful context fits before truncation.",
	].join("\n");
	const expected = "# Summary **Implemented** the compact preview. - Removed blank lines and indentation. - Reflowed text across all three rows. > More useful context fits before truncation.";
	for (const rows of [24, 60]) {
		const h = picker(t, [assistantMessage(reply)], rows);
		const preview = h.preview();
		assert.ok(preview.every((line) => line.trim().length > 0));
		assert.equal(preview.join(" "), expected);
		h.component.handleInput!("\x03");
		assert.equal(await h.selection, undefined);
	}
});

test("preview preserves Markdown and code verbatim apart from whitespace", async (t) => {
	const source = "## **Summary**\n\n```ts\nconst value = 2 ** 3;\n```\n\n[Guide](https://example.com) and \\*literal\\*.";
	const h = picker(t, [assistantMessage(source)]);
	const entries = structuredClone(h.entries);
	assert.deepEqual(h.preview(120), ["## **Summary** ```ts const value = 2 ** 3; ``` [Guide](https://example.com) and \\*literal\\*.", "", ""]);
	h.component.handleInput!("\r");
	assert.equal(await h.selection, h.entries[0]);
	assert.deepEqual(h.entries, entries);
});

test("preview truncation counts reflowed rows rather than source lines", async (t) => {
	const text = "alpha\n\nbeta\n\ngamma\n\ndelta\n\nepsilon\n\nzeta";
	const h = picker(t, [text, `${text}\n\neta\n\ntheta\n\niota`]);
	assert.deepEqual(h.preview(20), ["alpha beta gamma", "delta epsilon", "zeta eta theta…"]);
	h.component.handleInput!("\x1b[A");
	assert.deepEqual(h.preview(20), ["alpha beta gamma", "delta epsilon", "zeta"]);
	h.component.handleInput!("\x03");
	assert.equal(await h.selection, undefined);
});

test("preview sanitizes terminal controls and leaves empty content blank", async (t) => {
	const text = "\x1b[31mA\x1b[0m\r\n\tB \x07 \x00 C\x1b]8;;https://example.com\x07 link\x1b]8;;\x07\rD";
	const h = picker(t, [" \n\t\n ", "---\n\n***", text]);
	assert.deepEqual(h.preview(), ["A B C link D", "", ""]);
	h.component.handleInput!("\x1b[A");
	assert.deepEqual(h.preview(), ["--- ***", "", ""]);
	h.component.handleInput!("\x1b[A");
	assert.deepEqual(h.preview(), ["", "", ""]);
	h.component.handleInput!("\x03");
	assert.equal(await h.selection, undefined);
});

test("bash and tool output are reflowed without interpreting Markdown", async (t) => {
	const source = SessionManager.inMemory();
	source.appendMessage({ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "# Heading\n---\n*value*" }], isError: false, timestamp: 1 });
	source.appendMessage({ role: "bashExecution", command: "echo '**literal**'", output: "# Heading\n---\n*value*", exitCode: 0, cancelled: false, truncated: false, timestamp: 2 });
	const h = picker(t, source);
	h.component.handleInput!("\x01");
	assert.deepEqual(h.preview(), ["echo '**literal**' # Heading --- *value*", "", ""]);
	h.component.handleInput!("\x1b[A");
	assert.deepEqual(h.preview(), ["# Heading --- *value*", "", ""]);
	h.component.handleInput!("\x03");
	assert.equal(await h.selection, undefined);
});

test("native filters start in no-tools and retain their state across resize without editing history", async (t) => {
	const source = SessionManager.inMemory();
	source.appendModelChange("openai", "gpt-4o");
	const first = source.appendMessage({ role: "user", content: "Review the change", timestamp: 1 });
	const toolCall = { type: "toolCall" as const, id: "read-1", name: "read", arguments: { path: "index.ts" } };
	source.appendMessage(assistantMessage("", {
		content: [{ type: "text", text: "Still checking" }, toolCall],
		stopReason: "toolUse",
	}));
	source.appendMessage({ role: "toolResult", toolCallId: toolCall.id, toolName: "read", content: [{ type: "text", text: "Tool output" }], isError: false, timestamp: 2 });
	source.appendMessage(assistantMessage("", { content: [toolCall], stopReason: "toolUse" }));
	source.appendMessage(assistantMessage("Interrupted reply", { stopReason: "aborted" }));
	const compaction = source.appendCompaction("Summary checkpoint\nRetained decisions\nRemaining work\nFurther context", first, 12000);
	source.appendLabelChange(compaction, "Checkpoint");
	source.appendCustomMessageEntry("context", [{ type: "text", text: "Continuation" }, { type: "text", text: "context" }], true);
	source.appendCustomEntry("extension-state", { hidden: true });
	const original = structuredClone(source.getEntries());
	const h = picker(t, source);
	const lines = h.render();
	const native = new TreeSelectorComponent(source.getTree(), source.getLeafId(), 60, () => {}, () => {}, undefined, undefined, "no-tools").getTreeList();
	for (const line of native.render(80).map(stripVTControlCharacters)) assert.ok(lines.includes(line), line);
	assert.ok(lines.some((line) => line.includes("[no-tools]")));
	assert.ok(lines.some((line) => line.includes("[compaction: 12k tokens]")));
	assert.ok(lines.some((line) => line.includes("Still checking")));
	assert.ok(lines.some((line) => line.includes("Interrupted reply")));
	assert.ok(!lines.some((line) => /\[read:|extension-state|\[model:/.test(line)));
	assert.deepEqual(h.preview(), ["Continuation context", "", ""]);
	h.component.handleInput!("\x01"); // Pi's Ctrl+A: show all entries.
	assert.ok(h.render().some((line) => line.includes("extension-state")));
	assert.ok(h.render().some((line) => line.includes("[all]")));
	h.component.handleInput!("T"); // Pi's Shift+T: show label timestamps, not search text.
	assert.ok(h.render().some((line) => line.includes("[+label time]")));
	h.type("compaction");
	assert.deepEqual(h.preview(), ["Summary checkpoint Retained decisions Remaining work Further context", "", ""]);
	h.tui.terminal.rows = 24;
	assert.deepEqual(h.preview(), ["Summary checkpoint Retained decisions Remaining work Further context", "", ""]);
	assert.ok(h.render().some((line) => line.includes("[all]") && line.includes("[+label time]")));
	h.component.handleInput!("\r");
	assert.equal(await h.selection, source.getEntry(compaction));
	assert.deepEqual(source.getEntries(), original);
});

test("the native picker follows only the active branch after rewinding and switching paths", async (t) => {
	const source = SessionManager.inMemory();
	const ids = ["1", "2", "3", "4", "5"].map((content, timestamp) =>
		source.appendMessage({ role: "user", content, timestamp }),
	);
	const check = async (expected: string[]) => {
		const h = picker(t, source);
		const users = () => h.render().filter((line) => line.includes("user: ")).map((line) => line.split("user: ")[1].trim());
		assert.deepEqual(users(), expected);
		h.component.handleInput!("\x01");
		assert.deepEqual(users(), expected, "show-all cannot expose an abandoned branch");
		h.component.handleInput!("\x03");
		assert.equal(await h.selection, undefined);
	};
	source.branch(ids[2]);
	await check(["1", "2", "3"]);
	for (const content of ["4A", "5A"]) source.appendMessage({ role: "user", content, timestamp: 6 });
	await check(["1", "2", "3", "4A", "5A"]);
	source.branch(ids[4]);
	await check(["1", "2", "3", "4", "5"]);
	source.resetLeaf();
	await check([]);
});

test("clearing a no-match search after resize restores the previous selection", async (t) => {
	const h = picker(t, ["An early target", ...Array.from({ length: 50 }, (_, i) => `Unrelated ${i}`), "A later target"]);
	h.type("target");
	assert.ok(!h.render().some((line) => line.includes("Unrelated")));
	h.component.handleInput!("\x1b[A");
	assert.deepEqual(h.preview(), ["An early target", "", ""]);
	h.type("missing");
	assert.ok(h.render().some((line) => line.includes("No entries found")));
	assert.deepEqual(h.preview(), ["", "", ""]);
	h.tui.terminal.rows = 24;
	h.component.invalidate();
	assert.ok(h.render().some((line) => line.includes("Type to search: targetmissing")));
	h.component.handleInput!("\x1b");
	assert.deepEqual(h.preview(), ["An early target", "", ""]);
	assert.ok(h.render().some((line) => line.includes("Unrelated")));
	h.component.handleInput!("\r");
	assert.equal(await h.selection, h.entries[0]);
});

test("fullscreen left/right page the inline picker while Page Up/Down retain chat scrolling", async (t) => {
	let input!: (data: string) => void;
	const noop = () => {};
	const terminal: Terminal = {
		columns: 80, rows: 60, kittyProtocolActive: false,
		start: (onInput) => { input = onInput; }, stop: noop, drainInput: async () => {},
		write: noop, moveBy: noop, hideCursor: noop, showCursor: noop, clearLine: noop,
		clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop, setProgramStatus: noop,
	};
	const tui = new TuiAltScreen(terminal);
	t.after(() => tui.stop());
	const chat: Component = { render: () => Array.from({ length: 200 }, (_, i) => `Chat line ${i}`), invalidate: noop };
	tui.addChild(chat);
	tui.setFocus(chat);
	tui.start();
	const h = picker(t, Array.from({ length: 60 }, (_, i) => `Message ${i + 1}`), 60, tui);
	tui.renderNow();
	const scrollTop = tui.viewportTop;
	assert.ok(scrollTop > 0);
	const background = tui.getScreenLines().slice(0, 10);
	assert.equal(tui.hasOverlay(), false);

	// Send terminal events through Pi's fullscreen router, not directly to the list.
	for (const [left, right] of [["\x1b[D", "\x1b[C"], ["\x1b[1;1:1D", "\x1b[1;1:1C"]]) {
		input(left);
		tui.renderNow();
		assert.deepEqual(h.preview(), ["Message 30", "", ""]);
		assert.equal(tui.viewportTop, scrollTop);
		assert.deepEqual(tui.getScreenLines().slice(0, 10), background);
		input(right);
		tui.renderNow();
		assert.deepEqual(h.preview(), ["Message 60", "", ""]);
		assert.equal(tui.viewportTop, scrollTop);
	}
	input("\x1b[1;1:3D");
	assert.deepEqual(h.preview(), ["Message 60", "", ""], "key release must not page again");
	input("\x1b[5~");
	assert.ok(tui.viewportTop < scrollTop);
	assert.deepEqual(h.preview(), ["Message 60", "", ""]);
	input("\x1b[6~");
	assert.equal(tui.viewportTop, scrollTop);
	input("\x1b");
	assert.equal(await h.selection, undefined);
});

test("layout starts at native list height and wraps Unicode previews to the available width", async (t) => {
	const text = "Review 日本語, 😀, and e\u0301 carefully. ".repeat(20) + "Hidden tail";
	for (const rows of [20, 24, 32, 60, 100]) {
		const h = picker(t, [...Array.from({ length: 80 }, (_, i) => `Message ${i + 1}`), text], rows);
		const nativeList = new TreeSelectorComponent(h.source.getTree(), h.source.getLeafId(), rows, () => {}, () => {}).getTreeList();
		assert.equal(h.render().filter((line) => line.includes("user:")).length,
			nativeList.render(80).filter((line) => line.includes("user:")).length);
		for (const width of [8, 24, 80]) {
			const lines = h.component.render(width);
			assert.ok(lines.length <= rows - 2);
			assert.ok(lines.every((line) => visibleWidth(line) <= width && !/[\r\n]/.test(line)));
			assert.ok(h.render(width).at(-1)?.match(/^─+$/));
			assert.ok(h.preview(width)[2].endsWith("…"));
			assert.ok(!h.preview(width).join(" ").includes("Hidden tail"));
		}
		const lines = h.render(120);
		assert.equal(lines.filter((line) => /\(\d+\/\d+\)/.test(line)).length, 1);
		if (rows >= 32) assert.ok(lines.some((line) => line.includes("↑/↓ move · ←/→ page")));
		assert.notDeepEqual(h.preview(24), h.preview(80));
		h.tui.terminal.rows = rows + 20;
		assert.equal(h.render().filter((line) => line.includes("user:")).length,
			nativeList.render(80).filter((line) => line.includes("user:")).length);
		h.component.handleInput!("\x03");
		assert.equal(await h.selection, undefined);
	}
});

test("native navigation honors configured keys and Ctrl+C cancels even during search", async (t) => {
	const kb = getKeybindings();
	const original = kb.getUserBindings();
	t.after(() => kb.setUserBindings(original));
	kb.setUserBindings({ "tui.select.up": "k", "tui.select.cancel": "q", "tui.editor.cursorLeft": "h", "tui.editor.cursorRight": "l", "app.tree.filter.all": "a" });
	const h = picker(t, ["First", ...Array.from({ length: 40 }, (_, i) => `Middle ${i}`), "Latest"]);
	h.component.handleInput!("a");
	assert.ok(h.render().some((line) => line.includes("[all]")));
	h.component.handleInput!("h");
	assert.ok(h.preview()[0].startsWith("Middle"));
	h.component.handleInput!("l");
	assert.deepEqual(h.preview(), ["Latest", "", ""]);
	h.component.handleInput!("k");
	assert.deepEqual(h.preview(), ["Middle 39", "", ""]);
	assert.ok(h.render(120).some((line) => line.includes("k/↓ move") && line.includes("h/l page") && line.includes("q/ctrl+c cancel")));
	h.type("First");
	h.component.handleInput!("\x03");
	assert.equal(await h.selection, undefined);
});
