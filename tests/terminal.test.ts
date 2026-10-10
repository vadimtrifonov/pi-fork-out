import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTarget } from "../extensions/fork-out/terminals/index.ts";
import { warp } from "../extensions/fork-out/terminals/warp.ts";
import { windowsTerminal } from "../extensions/fork-out/terminals/windows-terminal.ts";

const warpEnv = { TERM_PROGRAM: "WarpTerminal" };

test("Warp defaults to tabs on both platforms and takes precedence over inherited WT_SESSION", () => {
	for (const platform of ["win32", "darwin"] as const) {
		assert.deepEqual(resolveTarget("", platform, { ...warpEnv, WT_SESSION: "inherited" }), { adapter: warp, destination: "tab" });
		assert.deepEqual(resolveTarget(" WINDOW ", platform, warpEnv), { adapter: warp, destination: "window" });
		assert.throws(() => resolveTarget("pane", platform, warpEnv), /tab or window/);
		assert.throws(() => resolveTarget("invalid", platform, warpEnv), /tab or window/);
	}
	assert.throws(() => resolveTarget("tab", "linux", warpEnv), /not supported on linux/);
});

test("Windows Terminal retains its destinations and outside-terminal window launch", () => {
	assert.deepEqual(resolveTarget("", "win32", { WT_SESSION: "parent" }), { adapter: windowsTerminal, destination: "pane" });
	for (const destination of ["pane", "tab", "window"]) {
		assert.deepEqual(resolveTarget(destination, "win32", { WT_SESSION: "parent" }), { adapter: windowsTerminal, destination });
	}
	assert.deepEqual(resolveTarget("window", "win32", {}), { adapter: windowsTerminal, destination: "window" });
	assert.throws(() => resolveTarget("invalid", "win32", { WT_SESSION: "parent" }), /pane or tab or window/);
	assert.throws(() => resolveTarget("tab", "win32", {}), /inside Windows Terminal or Warp/);
	assert.throws(() => resolveTarget("window", "darwin", {}), /inside Warp/);
	assert.throws(() => resolveTarget("window", "darwin", { WT_SESSION: "inherited" }), /not supported on darwin/);
});
