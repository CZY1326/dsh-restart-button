#!/usr/bin/env node
/**
 * Undoes `patch-asar.cjs`: writes the original lib/main.js bytes back into the
 * archive. Close the application first, then open it again.
 *
 * Usage:
 *   node scripts/restore-asar.cjs [--asar <path to app.asar>] [--check]
 *
 * `--check` only reports the current state (original / patched / unknown).
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const BAK_SUFFIX = ".dsh-restart-button.bak";
const MANIFEST_SUFFIX = ".dsh-restart-button.json";

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function locateArchive() {
	const explicit = process.argv.indexOf("--asar");
	if (explicit >= 0) {
		const value = process.argv[explicit + 1];
		if (value === void 0) throw new Error("--asar needs a path");
		return path.resolve(value);
	}
	if (process.env.DSH_ASAR !== void 0 && process.env.DSH_ASAR !== "") return path.resolve(process.env.DSH_ASAR);
	throw new Error("pass --asar <path> or set DSH_ASAR to the app.asar this plugin patched");
}

function main() {
	const checkOnly = process.argv.includes("--check");
	const archivePath = locateArchive();
	const manifestPath = archivePath + MANIFEST_SUFFIX;
	if (!fs.existsSync(manifestPath)) throw new Error(`no patch manifest at ${manifestPath}`);
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	if (manifest.archive !== archivePath) throw new Error(`manifest belongs to ${manifest.archive}`);

	const original = fs.readFileSync(archivePath + BAK_SUFFIX);
	if (original.length !== manifest.size) throw new Error("backup size does not match the manifest");
	if (sha256(original) !== manifest.sha256Original) throw new Error("backup hash does not match the manifest");

	const fd = fs.openSync(archivePath, checkOnly ? "r" : "r+");
	try {
		const current = Buffer.alloc(original.length);
		fs.readSync(fd, current, 0, original.length, manifest.offset);
		const digest = sha256(current);
		const state = digest === manifest.sha256Original ? "original" : digest === manifest.sha256Patched ? "patched" : "unknown";
		console.log(JSON.stringify({ archive: archivePath, version: manifest.version, offset: manifest.offset, size: original.length, state, checkOnly }, null, 2));
		if (checkOnly || state === "original") return;
		if (state === "unknown") throw new Error("the archive contains neither the patched nor the original bytes; nothing was written");
		fs.writeSync(fd, original, 0, original.length, manifest.offset);
		fs.fsyncSync(fd);
		const verify = Buffer.alloc(original.length);
		fs.readSync(fd, verify, 0, original.length, manifest.offset);
		console.log(JSON.stringify({ restored: sha256(verify) === manifest.sha256Original }, null, 2));
	} finally {
		fs.closeSync(fd);
	}
}

try {
	main();
} catch (error) {
	console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
