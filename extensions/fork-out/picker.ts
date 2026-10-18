import { stripVTControlCharacters } from "node:util";
import { contentText } from "@earendil-works/pi-ai";
import { DynamicBorder, TreeSelectorComponent, type ExtensionCommandContext, type SessionEntry, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Spacer, TruncatedText, truncateToWidth, wrapTextWithAnsi, type Keybinding } from "@earendil-works/pi-tui";

function previewText(entry: SessionEntry | undefined): string {
	if (!entry) return "";
	if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary;
	if (entry.type === "custom_message") return contentText(entry.content, " ");
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "bashExecution") return `${message.command}\n${message.output}`;
		if ("content" in message) {
			return contentText(message.content, " ") || (message.role === "assistant" ? message.errorMessage ?? "" : "");
		}
	}
	return "";
}

export async function selectForkEntry(
	ctx: ExtensionCommandContext,
	entries: SessionEntry[],
): Promise<SessionEntry | undefined> {
	const selectedId = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const nodes: SessionTreeNode[] = entries.map((entry) => ({
			entry,
			label: ctx.sessionManager.getLabel(entry.id),
			children: [],
		}));
		for (let index = 1; index < nodes.length; index++) nodes[index - 1].children.push(nodes[index]);
		const roots = nodes.slice(0, 1);
		const leafId = entries.at(-1)?.id ?? null;
		const border = new DynamicBorder((text) => theme.fg("border", text));
		const list = new TreeSelectorComponent(
			roots, leafId, tui.terminal.rows, done, () => done(undefined), undefined, undefined, "no-tools",
		).getTreeList();
		list.onLabelEdit = undefined;

		const component = {
			focused: false,
			render(width: number) {
				if (!this.focused) return [];
				const compact = tui.terminal.rows < 32;
				const contentWidth = Math.max(1, width - 4);
				const content = stripVTControlCharacters(previewText(list.getSelectedNode()?.entry))
					.replace(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/g, "")
					.replace(/\s+/g, " ")
					.trim();
				const preview = wrapTextWithAnsi(content, contentWidth);
				if (preview.length > 3) preview[2] = `${truncateToWidth(preview[2], contentWidth - 1, "")}…`;
				const text = (value: string) => new TruncatedText(value, 2, 0);
				const keys = (action: Keybinding) => (keybindings.getKeys(action)[0] ?? "")
					.replace(/\bup\b/g, "↑").replace(/\bdown\b/g, "↓")
					.replace(/\bleft\b/g, "←").replace(/\bright\b/g, "→");
				const cancel = [...new Set([...keybindings.getKeys("tui.select.cancel"), "ctrl+c"])].join("/");
				const frame = new Container();
				if (!compact) {
					frame.addChild(new Spacer(1));
					frame.addChild(border);
				}
				frame.addChild(text(theme.bold("Fork session")));
				if (!compact) frame.addChild(text(theme.fg("muted", `${keys("tui.select.up")}/${keys("tui.select.down")} move · ${keys("tui.editor.cursorLeft")}/${keys("tui.editor.cursorRight")} page · ${keys("tui.select.confirm")} fork · ${cancel} cancel`)));
				frame.addChild(text(theme.fg("muted", "Type to search: ") + theme.fg("accent", list.getSearchQuery())));
				if (!compact) {
					frame.addChild(border);
					frame.addChild(new Spacer(1));
				}
				frame.addChild(list);
				if (!compact) frame.addChild(new Spacer(1));
				for (let line = 0; line < 3; line++) frame.addChild(text(theme.fg("muted", preview[line] ?? "")));
				if (!compact) frame.addChild(new Spacer(1));
				frame.addChild(border);
				return frame.render(width);
			},
			invalidate: () => list.invalidate(),
			handleInput(data: string) {
				if (matchesKey(data, Key.ctrl("c"))) return done(undefined);
				list.handleInput(data);
				tui.requestRender();
			},
		};
		return component;
	});

	return entries.find((entry) => entry.id === selectedId);
}
