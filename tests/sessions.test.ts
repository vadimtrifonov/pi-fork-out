import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createBranch, getForkChoices, getPendingForkDraft } from "../extensions/fork-out/sessions.ts";

function sourceSession(t: TestContext): SessionManager {
	const directory = mkdtempSync(join(tmpdir(), "pi-fork-out-sessions-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return SessionManager.create(directory, join(directory, "sessions"));
}

test("cloning copies only the selected path, preserves metadata, and leaves the parent untouched", (t) => {
	const source = sourceSession(t);
	source.appendModelChange("openai", "gpt-4o");
	const first = source.appendMessage({ role: "user", content: "First prompt", timestamp: 1 });
	source.appendCustomEntry("other-extension", { preserved: true });
	source.appendCompaction("Summary", first, 500);
	const leaf = source.appendThinkingLevelChange("high");
	source.branch(first);
	const alternative = source.appendMessage({ role: "user", content: "Other branch", timestamp: 2 });
	source.branch(leaf);
	const parentFile = source.getSessionFile()!;
	const originalFile = readFileSync(parentFile, "utf8");
	const originalEntries = structuredClone(source.getEntries());
	const copyFile = createBranch(source, source.getLeafId());
	const copy = SessionManager.open(copyFile);

	assert.notEqual(copyFile, parentFile);
	assert.notEqual(copy.getSessionId(), source.getSessionId());
	assert.equal(copy.getHeader()!.parentSession, parentFile);
	assert.equal(copy.getCwd(), source.getCwd());
	assert.deepEqual(copy.getEntries(), JSON.parse(JSON.stringify(source.getBranch())));
	assert.equal(copy.getEntry(alternative), undefined);
	assert.equal(source.getLeafId(), leaf);
	assert.deepEqual(source.getEntries(), originalEntries);
	assert.equal(readFileSync(parentFile, "utf8"), originalFile);
});

test("forking excludes the chosen message, stores its draft, and supports the first message", (t) => {
	const source = sourceSession(t);
	const first = source.appendMessage({ role: "user", content: "First prompt", timestamp: 1 });
	const parent = source.appendCustomEntry("other-extension", { value: 1 });
	const second = source.appendMessage({ role: "user", content: [{ type: "text", text: "Second " }, { type: "text", text: "prompt" }], timestamp: 2 });
	source.appendMessage({ role: "user", content: "  ", timestamp: 3 });
	const choices = getForkChoices(source);
	assert.deepEqual(choices.map(({ entry, text }) => [entry.id, text]), [[first, "First prompt"], [second, "Second prompt"]]);

	for (const choice of choices) {
		const copy = SessionManager.open(createBranch(source, choice.entry.parentId, choice.text));
		const expectedHistory = choice.entry.id === first ? [] : source.getBranch(parent);
		assert.deepEqual(copy.getEntries().slice(0, -1), expectedHistory);
		assert.equal(copy.getEntry(choice.entry.id), undefined);
		assert.equal(getPendingForkDraft(copy)?.text, choice.text);
		assert.equal(copy.getHeader()!.parentSession, source.getSessionFile());
	}
});

test("copies include unflushed setup entries and reject non-persistent sources", (t) => {
	const source = sourceSession(t);
	source.appendModelChange("openai", "gpt-4o");
	assert.ok(!existsSync(source.getSessionFile()!));
	const copyFile = createBranch(source, source.getLeafId());
	assert.deepEqual(SessionManager.open(copyFile).getEntries(), source.getEntries());
	assert.ok(!existsSync(source.getSessionFile()!));
	assert.throws(() => createBranch(SessionManager.inMemory(source.getCwd()), null), /persistence is disabled/);
});

test("draft application and later drafts are evaluated only on the active branch", (t) => {
	const source = sourceSession(t);
	const first = source.appendCustomEntry("pi-fork-out-fork-draft", { text: "First draft" });
	assert.deepEqual(getPendingForkDraft(source), { id: first, text: "First draft" });
	const applied = source.appendCustomEntry("pi-fork-out-fork-draft-applied", { draftId: first });
	assert.equal(getPendingForkDraft(source), undefined);

	source.branch(first);
	const second = source.appendCustomEntry("pi-fork-out-fork-draft", { text: "Second draft" });
	source.appendCustomEntry("pi-fork-out-fork-draft", { text: 42 });
	source.appendCustomEntry("pi-fork-out-fork-draft-applied", null);
	assert.deepEqual(getPendingForkDraft(source), { id: second, text: "Second draft" });
	source.branch(applied);
	assert.equal(getPendingForkDraft(source), undefined);
});
