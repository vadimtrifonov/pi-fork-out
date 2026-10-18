import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function getPiInvocation(): string[] {
	const piEntry = process.argv[1];
	if (piEntry) {
		const piCli = resolve(piEntry);
		if (existsSync(piCli)) return [process.execPath, piCli];
	}
	throw new Error("The Pi CLI entrypoint is no longer available. Restart Pi and try again.");
}
