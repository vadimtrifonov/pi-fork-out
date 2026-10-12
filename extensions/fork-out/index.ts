import {
	UserMessageSelectorComponent,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createBranch, getForkChoices, getPendingForkDraft, markForkDraftApplied, type ForkChoice } from "./sessions.ts";
import { resolveTarget, type LaunchTarget } from "./terminals/index.ts";

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

async function openBranch(
	action: "Clone" | "Fork",
	ctx: ExtensionCommandContext,
	target: LaunchTarget,
	leafId: string | null,
	draftText?: string,
): Promise<void> {
	let sessionFile: string | undefined;
	try {
		sessionFile = createBranch(ctx.sessionManager, leafId, draftText);
		await target.adapter.launch({
			sessionFile,
			cwd: ctx.cwd,
			destination: target.destination,
		});
		ctx.ui.notify(`Opened ${action.toLowerCase()} in a new ${target.destination}`, "info");
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
			"Clone the current session into a new pane, tab, or window (default: pane)",
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
			"Fork from a previous user message into a new pane, tab, or window (default: pane)",
		handler: async (args, ctx) => {
			const target = parseTarget("fork-out", args, ctx);
			if (!target) return;

			const choices = getForkChoices(ctx.sessionManager);
			if (choices.length === 0) {
				ctx.ui.notify("No user messages to fork from", "error");
				return;
			}

			const choice = await selectForkChoice(ctx, choices);
			if (!choice) return;

			await openBranch("Fork", ctx, target, choice.entry.parentId, choice.text);
		},
	});
}
