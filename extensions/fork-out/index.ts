import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { selectForkEntry } from "./picker.ts";
import { createBranch, getPendingForkDraft, markForkDraftApplied } from "./sessions.ts";
import { resolveTarget, type LaunchTarget } from "./terminals/index.ts";

function completeDestination(prefix: string) {
	const choices = [
		{ value: "right", description: "New pane to the right" },
		{ value: "down", description: "New pane below" },
		{ value: "tab", description: "New tab" },
		{ value: "window", description: "New Windows Terminal window" },
	];
	const query = prefix.trimStart().toLowerCase();
	const matches = choices.filter(({ value }) => value !== query && value.startsWith(query));
	return matches.length > 0 ? matches.map((choice) => ({ ...choice, label: choice.value })) : null;
}

function parseTarget(
	command: "clone-out" | "fork-out",
	args: string,
	ctx: ExtensionCommandContext,
): LaunchTarget | undefined {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`/${command} requires interactive mode`, "error");
		return undefined;
	}
	try {
		return resolveTarget(args);
	} catch (error) {
		ctx.ui.notify(`/${command}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return undefined;
	}
}

async function openBranch(
	action: "Clone" | "Fork",
	ctx: ExtensionCommandContext,
	target: LaunchTarget,
	leafId: string | null,
	draftText?: string | null,
): Promise<void> {
	let sessionFile: string | undefined;
	try {
		sessionFile = createBranch(ctx.sessionManager, leafId, draftText);
		await target.adapter.launch({
			sessionFile,
			cwd: ctx.cwd,
			destination: target.destination,
		});
		const location = target.destination === "right" ? "pane to the right"
			: target.destination === "down" ? "pane below" : target.destination;
		ctx.ui.notify(`Opened ${action.toLowerCase()} in a new ${location}`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const kept = sessionFile ? `\nSession copy kept at: ${sessionFile}` : "";
		ctx.ui.notify(`${action} failed: ${message}${kept}`, "error");
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const draft = getPendingForkDraft(ctx.sessionManager);
		if (!draft) return;

		markForkDraftApplied(pi, draft);
		ctx.ui.setEditorText(draft.text);
	});

	pi.registerCommand("clone-out", {
		description:
			"Clone the current session into a new pane, tab, or window (default: pane to the right)",
		getArgumentCompletions: completeDestination,
		handler: async (args, ctx) => {
			const target = parseTarget("clone-out", args, ctx);
			if (!target) return;

			const leafId = ctx.sessionManager.getLeafId();
			if (!leafId) {
				ctx.ui.notify("Nothing to clone yet", "error");
				return;
			}

			await openBranch("Clone", ctx, target, leafId);
		},
	});

	pi.registerCommand("fork-out", {
		description:
			"Fork from the active branch into a new pane, tab, or window (default: pane to the right)",
		getArgumentCompletions: completeDestination,
		handler: async (args, ctx) => {
			const target = parseTarget("fork-out", args, ctx);
			if (!target) return;

			const entries = ctx.sessionManager.getBranch();
			if (entries.length === 0) {
				ctx.ui.notify("Nothing to fork yet", "error");
				return;
			}

			const entry = await selectForkEntry(ctx, entries);
			if (!entry) return;

			if (entry.type === "message" && entry.message.role === "user") {
				await openBranch("Fork", ctx, target, entry.parentId, contentText(entry.message.content, ""));
			} else {
				await openBranch("Fork", ctx, target, entry.id, null);
			}
		},
	});
}
