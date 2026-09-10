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
const FORK_DRAFT = "pi-fork-out-fork-draft";
const FORK_DRAFT_APPLIED = "pi-fork-out-fork-draft-applied";

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

function getPiInvocation(): string[] {
	const piEntry = process.argv[1];
	if (piEntry) {
		const piCli = resolve(piEntry);
		if (existsSync(piCli)) return [process.execPath, piCli];

		// mise installations are versioned, so an update can remove this process's entrypoint.
		const normalizedEntry = piCli.replaceAll("\\", "/").toLowerCase();
		if (normalizedEntry.includes("/mise/installs/")) return ["mise.exe", "exec", "--", "pi"];
	}

	throw new Error("Could not locate the Pi CLI entrypoint");
}

function launchBranch(destination: Destination, cwd: string, sessionFile: string): Promise<void> {
	const piInvocation = getPiInvocation();
	const action = destination === "pane" ? ["split-pane", "--vertical"] : ["new-tab"];
	const window = destination === "window" ? "new" : "0";
	const args = [
		"--window",
		window,
		...action,
		"--startingDirectory",
		cwd,
		...piInvocation,
		"--session",
		sessionFile,
	];

	return new Promise((resolve, reject) => {
		const child = spawn("wt.exe", args, {
			detached: true,
			stdio: "ignore",
			// SW_HIDE also hides a newly created Terminal window.
			windowsHide: destination !== "window",
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

function createBranch(ctx: ExtensionCommandContext, leafId: string | null, draftText?: string): string {
	const source = ctx.sessionManager;
	const parentSession = source.getSessionFile();
	if (!parentSession) throw new Error("Session persistence is disabled; start Pi without --no-session");

	// Read recorded entries, including those not yet flushed during the first response.
	// Branch only the detached copy: ctx.fork() would replace the running session.
	const snapshot = SessionManager.inMemory(source.getCwd(), undefined, leafId ? source.getEntries() : undefined);
	if (leafId) snapshot.createBranchedSession(leafId);
	if (draftText !== undefined) snapshot.appendCustomEntry(FORK_DRAFT, { text: draftText });

	const branch = SessionManager.create(source.getCwd(), source.getSessionDir(), { parentSession });
	const sessionFile = branch.getSessionFile();
	const header = branch.getHeader();
	if (!sessionFile || !header) throw new Error("Could not create the branched session");

	// The child needs a file for --session even if no assistant message exists yet.
	const entries = [header, ...snapshot.getEntries()];
	writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
		encoding: "utf8",
		flag: "wx",
	});
	return sessionFile;
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

		const component = {
			focused: false,
			render(width: number) {
				// Don't cover a tool dialog that temporarily takes keyboard focus.
				return this.focused ? selector.render(width) : [];
			},
			invalidate: () => selector.invalidate(),
			handleInput: (data: string) => {
				messageList.handleInput(data);
				tui.requestRender();
			},
		};
		return component;
	}, { overlay: true });

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

			const leafId = ctx.sessionManager.getLeafId();
			if (!leafId) {
				ctx.ui.notify("Nothing to clone yet", "error");
				return;
			}

			try {
				const cloneFile = createBranch(ctx, leafId);
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

			const choices = getForkChoices(ctx);
			if (choices.length === 0) {
				ctx.ui.notify("No user messages to fork from", "error");
				return;
			}

			const choice = await selectForkChoice(ctx, choices);
			if (!choice) return;

			try {
				const forkFile = createBranch(ctx, choice.entry.parentId, choice.text);
				await launchBranch(destination, ctx.cwd, forkFile);
				ctx.ui.notify(`Opened fork in a new ${destination}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Fork failed: ${message}`, "error");
			}
		},
	});
}
