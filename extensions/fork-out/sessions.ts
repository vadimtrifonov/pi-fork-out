import { writeFileSync } from "node:fs";
import { contentText } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

const FORK_DRAFT = "pi-fork-out-fork-draft";
const FORK_DRAFT_APPLIED = "pi-fork-out-fork-draft-applied";

type SessionSource = ExtensionContext["sessionManager"];
type ForkDraft = { id: string; text: string };
export type ForkChoice = { entry: SessionEntry; text: string };

export function createBranch(source: SessionSource, leafId: string | null, draftText?: string): string {
	const parentSession = source.getSessionFile();
	if (!parentSession) throw new Error("Session persistence is disabled; start Pi without --no-session");

	// Read recorded entries, including those not yet flushed to disk.
	// Branch only a detached copy; never replace the running session.
	const snapshot = SessionManager.inMemory(source.getCwd(), undefined, leafId ? source.getEntries() : undefined);
	if (leafId) snapshot.createBranchedSession(leafId);
	if (draftText !== undefined) snapshot.appendCustomEntry(FORK_DRAFT, { text: draftText });

	const branch = SessionManager.create(source.getCwd(), source.getSessionDir(), { parentSession });
	const sessionFile = branch.getSessionFile();
	const header = branch.getHeader();
	if (!sessionFile || !header) throw new Error("Could not create the branched session");

	// The child needs a --session file even when only setup or draft entries exist.
	const entries = [header, ...snapshot.getEntries()];
	writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
		encoding: "utf8",
		flag: "wx",
	});
	return sessionFile;
}

export function getForkChoices(source: SessionSource): ForkChoice[] {
	const choices: ForkChoice[] = [];
	for (const entry of source.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = contentText(entry.message.content, "");
		if (text.trim()) choices.push({ entry, text });
	}
	return choices;
}

export function getPendingForkDraft(source: SessionSource): ForkDraft | undefined {
	let draft: ForkDraft | undefined;
	const applied = new Set<string>();
	for (const entry of source.getBranch()) {
		if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object") continue;
		const data = entry.data as { draftId?: unknown; text?: unknown };
		if (entry.customType === FORK_DRAFT && typeof data.text === "string") {
			draft = { id: entry.id, text: data.text };
		}
		if (entry.customType === FORK_DRAFT_APPLIED && typeof data.draftId === "string") {
			applied.add(data.draftId);
		}
	}
	return draft && !applied.has(draft.id) ? draft : undefined;
}

export function markForkDraftApplied(pi: Pick<ExtensionAPI, "appendEntry">, draft: ForkDraft): void {
	pi.appendEntry(FORK_DRAFT_APPLIED, { draftId: draft.id });
}
