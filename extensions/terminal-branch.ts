import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import {
	SessionManager,
	UserMessageSelectorComponent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

const DESTINATIONS = ["pane", "tab", "window"] as const;
const FORK_DRAFT = "pi-terminal-branch-fork-draft";
const FORK_DRAFT_APPLIED = "pi-terminal-branch-fork-draft-applied";

type Destination = (typeof DESTINATIONS)[number];
type ForkDraft = { id: string; text: string };
type ForkChoice = { entry: SessionEntry; text: string };

function isDestination(value: string): value is Destination {
	return DESTINATIONS.includes(value as Destination);
}

function parseDestination(
	command: "clone-out" | "fork-out",
	args: string,
	ctx: ExtensionCommandContext,
): Destination | undefined {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`/${command} requires interactive mode`, "error");
		return undefined;
	}

	const destination = args.trim().toLowerCase() || "pane";
	if (!isDestination(destination)) {
		ctx.ui.notify(`Usage: /${command} [pane|tab|window] (default: pane)`, "error");
		return undefined;
	}
	if (process.platform !== "win32") {
		ctx.ui.notify(`/${command} currently supports Windows only`, "error");
		return undefined;
	}
	if (!process.env.WT_SESSION && destination !== "window") {
		ctx.ui.notify("Open Pi inside Windows Terminal to create a pane or tab", "error");
		return undefined;
	}
	return destination;
}

function getSessionFile(ctx: ExtensionCommandContext): string | undefined {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile || !existsSync(sessionFile)) {
		ctx.ui.notify("Nothing persisted yet; wait for the first response, then try again", "error");
		return undefined;
	}
	return sessionFile;
}

function launchBranch(destination: Destination, cwd: string, sessionFile: string): Promise<void> {
	const piEntry = process.argv[1];
	if (!piEntry) throw new Error("Could not locate the Pi CLI entrypoint");
	const piCli = resolve(piEntry);
	if (!existsSync(piCli)) throw new Error("Could not locate the Pi CLI entrypoint");

	const action = destination === "pane" ? ["split-pane", "--vertical"] : ["new-tab"];
	const window = destination === "window" ? "new" : "0";
	const args = [
		"--window",
		window,
		...action,
		"--startingDirectory",
		cwd,
		process.execPath,
		piCli,
		"--session",
		sessionFile,
	];

	return new Promise((resolve, reject) => {
		const child = spawn("wt.exe", args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

function ensurePersisted(manager: SessionManager): string {
	const sessionFile = manager.getSessionFile();
	const header = manager.getHeader();
	if (!sessionFile || !header) throw new Error("Could not create the branched session");

	// Pi defers files without an assistant response, but the child needs one for --session.
	if (!existsSync(sessionFile)) {
		const entries = [header, ...manager.getEntries()];
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
	}

	return sessionFile;
}

function createClone(sessionFile: string, leafId: string): string {
	const manager = SessionManager.open(sessionFile);
	manager.createBranchedSession(leafId);
	return ensurePersisted(manager);
}

function createFork(sessionFile: string, choice: ForkChoice): string {
	// ctx.fork() replaces the current runtime; a detached manager keeps the original running.
	const sourceManager = SessionManager.open(sessionFile);
	let forkManager: SessionManager;

	if (choice.entry.parentId) {
		sourceManager.createBranchedSession(choice.entry.parentId);
		forkManager = sourceManager;
	} else {
		forkManager = SessionManager.create(sourceManager.getCwd(), sourceManager.getSessionDir(), {
			parentSession: sessionFile,
		});
	}

	forkManager.appendCustomEntry(FORK_DRAFT, { text: choice.text });
	return ensurePersisted(forkManager);
}

function getForkChoices(ctx: ExtensionCommandContext): ForkChoice[] {
	const choices: ForkChoice[] = [];

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = contentText(entry.message.content, "");
		if (text.trim()) choices.push({ entry, text });
	}

	return choices;
}

async function selectForkChoice(
	ctx: ExtensionCommandContext,
	choices: ForkChoice[],
): Promise<ForkChoice | undefined> {
	const selectedId = await ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
		const selector = new UserMessageSelectorComponent(
			choices.map(({ entry, text }) => ({ id: entry.id, text })),
			(entryId) => done(entryId),
			() => done(undefined),
			choices.at(-1)?.entry.id,
		);
		const messageList = selector.getMessageList();

		return {
			render: (width) => selector.render(width),
			invalidate: () => selector.invalidate(),
			handleInput: (data) => {
				messageList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return choices.find(({ entry }) => entry.id === selectedId);
}

function getPendingForkDraft(ctx: ExtensionContext): ForkDraft | undefined {
	let draft: ForkDraft | undefined;
	const applied = new Set<string>();

	for (const entry of ctx.sessionManager.getBranch()) {
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

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const draft = getPendingForkDraft(ctx);
		if (!draft) return;

		pi.appendEntry(FORK_DRAFT_APPLIED, { draftId: draft.id });
		ctx.ui.setEditorText(draft.text);
	});

	pi.registerCommand("clone-out", {
		description:
			"Duplicate the current session at the current position in a new Windows Terminal pane, tab, or window (default: pane)",
		handler: async (args, ctx) => {
			const destination = parseDestination("clone-out", args, ctx);
			if (!destination) return;

			await ctx.waitForIdle();
			const leafId = ctx.sessionManager.getLeafId();
			if (!leafId) {
				ctx.ui.notify("Nothing to clone yet", "error");
				return;
			}
			const sessionFile = getSessionFile(ctx);
			if (!sessionFile) return;

			try {
				const cloneFile = createClone(sessionFile, leafId);
				await launchBranch(destination, ctx.cwd, cloneFile);
				ctx.ui.notify(`Opened clone in a new ${destination}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Clone failed: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("fork-out", {
		description:
			"Create a new fork from a previous user message in a new Windows Terminal pane, tab, or window (default: pane)",
		handler: async (args, ctx) => {
			const destination = parseDestination("fork-out", args, ctx);
			if (!destination) return;

			await ctx.waitForIdle();
			const sessionFile = getSessionFile(ctx);
			if (!sessionFile) return;

			const choices = getForkChoices(ctx);
			if (choices.length === 0) {
				ctx.ui.notify("No user messages to fork from", "error");
				return;
			}

			const choice = await selectForkChoice(ctx, choices);
			if (!choice) return;

			try {
				const forkFile = createFork(sessionFile, choice);
				await launchBranch(destination, ctx.cwd, forkFile);
				ctx.ui.notify(`Opened fork in a new ${destination}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Fork failed: ${message}`, "error");
			}
		},
	});
}
