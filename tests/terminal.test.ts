import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTarget } from "../extensions/fork-out/terminals/index.ts";
import { ghostty } from "../extensions/fork-out/terminals/ghostty.ts";
import { herdr } from "../extensions/fork-out/terminals/herdr.ts";
import { windowsTerminal } from "../extensions/fork-out/terminals/windows-terminal.ts";

const herdrEnv = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", WT_SESSION: "inherited", TERM_PROGRAM: "ghostty" };

test("Herdr supports Windows, macOS, and Linux ahead of inherited terminal markers", () => {
	for (const platform of ["win32", "darwin", "linux"] as const) {
		assert.deepEqual(resolveTarget(" ", platform, herdrEnv), { adapter: herdr, destination: "right" });
		for (const destination of ["right", "down", "tab"]) {
			assert.deepEqual(resolveTarget(` ${destination.toUpperCase()} `, platform, herdrEnv), { adapter: herdr, destination });
		}
	}
});

test("unsupported destinations are rejected", () => {
	for (const argument of ["windw", "pane", "left", "up", "right down"]) {
		assert.throws(() => resolveTarget(argument, "win32", herdrEnv));
	}
});

test("invalid destinations report the choices before terminal detection", () => {
	assert.throws(() => resolveTarget("windw", "win32", {}), /right.*down.*tab.*window/);
});

test("window opens the platform terminal, including from inside Herdr", () => {
	for (const env of [herdrEnv, { HERDR_ENV: "1" }, { WT_SESSION: "parent" }, {}]) {
		assert.deepEqual(resolveTarget(" WINDOW ", "win32", env), { adapter: windowsTerminal, destination: "window" });
		assert.deepEqual(resolveTarget(" WINDOW ", "darwin", env), { adapter: ghostty, destination: "window" });
	}
	assert.throws(() => resolveTarget("window", "linux", herdrEnv), /requires Ghostty on macOS or Windows Terminal on Windows/);
});

test("Ghostty panes and tabs require macOS and the current terminal marker", () => {
	for (const destination of ["", "right", "down", "tab"]) {
		assert.deepEqual(resolveTarget(destination, "darwin", { TERM_PROGRAM: "ghostty" }), {
			adapter: ghostty, destination: destination || "right",
		});
	}
	for (const platform of ["win32", "linux"] as const) {
		assert.throws(() => resolveTarget("tab", platform, { TERM_PROGRAM: "ghostty" }), /inside Herdr/);
	}
	assert.throws(() => resolveTarget("tab", "darwin", {
		TERM_PROGRAM: "another-terminal", GHOSTTY_RESOURCES_DIR: "/inherited/resources", GHOSTTY_BIN_DIR: "/inherited/bin",
	}), /inside Herdr or Ghostty/);
});

test("Windows Terminal is detected only on Windows", () => {
	assert.deepEqual(resolveTarget("", "win32", { WT_SESSION: "parent" }), { adapter: windowsTerminal, destination: "right" });
	for (const destination of ["right", "down", "tab"]) {
		assert.deepEqual(resolveTarget(destination, "win32", { WT_SESSION: "parent" }), { adapter: windowsTerminal, destination });
	}
	assert.throws(() => resolveTarget("tab", "win32", {}), /inside Herdr or Windows Terminal/);
	for (const platform of ["darwin", "linux"] as const) {
		assert.throws(() => resolveTarget("tab", platform, {}), /inside Herdr/);
		assert.throws(() => resolveTarget("tab", platform, { WT_SESSION: "inherited" }), /inside Herdr/);
	}
});
