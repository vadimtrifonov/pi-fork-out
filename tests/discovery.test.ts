import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, discoverAndLoadExtensions, SettingsManager } from "@earendil-works/pi-coding-agent";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

test("package and directory discovery load only the fork-out entry point", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-fork-out-discovery-"));
	const agentDir = join(root, "agent");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const settings of [
		{ packages: [packageRoot] },
		{ extensions: [join(packageRoot, "extensions")] },
	]) {
		const manager = new DefaultPackageManager({
			cwd: root,
			agentDir,
			settingsManager: SettingsManager.inMemory(settings),
			builtinExtensions: [],
		});
		const resources = await manager.resolve();
		const paths = resources.extensions.filter((entry) => entry.enabled).map((entry) => entry.path);
		assert.deepEqual(paths, [join(packageRoot, "extensions", "fork-out", "index.ts")]);
		const loaded = await discoverAndLoadExtensions(paths, root, agentDir);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		assert.deepEqual([...loaded.extensions[0].commands.keys()].sort(), ["clone-out", "fork-out"]);
	}
});
