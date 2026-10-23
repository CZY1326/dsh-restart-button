#!/usr/bin/env node
/**
 * Optional desktop-shell patch for dsh-restart-button.
 *
 * Adds two things to the packaged Electron main process:
 *   1. a "restart" entry in the tray context menu, between open and quit;
 *   2. a `dsh-app://app/__dsh-restart` route the header button can call for a
 *      graceful relaunch (`app.relaunch()`), instead of the kill-and-start shell.
 *
 * The archive is patched **in place, byte for byte**, keeping `lib/main.js` at
 * its original length: an asar is one big file with a JSON index, so a length
 * change would shift every later entry. Reclaimed bytes come from doc comments
 * that sit next to the patched code and are rewritten to the exact same width.
 *
 * Safety rules:
 *   - the script refuses to run unless `lib/main.js` matches a fingerprint it
 *     was written for (the patch is version specific),
 *   - the original bytes are written to `<app.asar>.dsh-restart-button.bak`
 *     before anything is touched; `restore-asar.cjs` puts them back,
 *   - the archive is re-read and hash-checked after the write.
 *
 * Usage:
 *   node scripts/patch-asar.cjs [--asar <path to app.asar>] [--dry-run]
 * Close the application first, then restart it to load the patch.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const ENTRY = "lib/main.js";
const BAK_SUFFIX = ".dsh-restart-button.bak";
const MANIFEST_SUFFIX = ".dsh-restart-button.json";

/**
 * Every edit the patch performs, tied to one exact packaged build. A different
 * build changes these anchors, so the script stops instead of guessing.
 */
const SUPPORTED = [
	{
		version: "0.2.1-rc.2",
		sha256: "6f3d1ddd1106371452c2204be6dfb2e5460a8e8259cdd05cdccb5387b3f9a85a",
		edits: [
			{
				from: [
					'\t\t\t{ type: "separator" },',
					"\t\t\t{",
					"\t\t\t\tlabel: messages.quitApplication,",
					"\t\t\t\tclick: () => {",
					"\t\t\t\t\tthis.options.quit();",
					"\t\t\t\t}",
					"\t\t\t}",
					"\t\t]));"
				].join("\n"),
				to: [
					'\t\t\t{ type: "separator" },',
					"\t\t\t// restart entry: stop the process and let Electron start it again",
					"\t\t\t{",
					"\t\t\t\tlabel: `${messages.restartApplication} ${messages.aboutProduct}`,",
					"\t\t\t\tclick: () => {",
					"\t\t\t\t\tapp.relaunch();",
					"\t\t\t\t\tquitWithoutConfirmation();",
					"\t\t\t\t}",
					"\t\t\t},",
					"\t\t\t{",
					"\t\t\t\tlabel: messages.quitApplication,",
					"\t\t\t\tclick: () => {",
					"\t\t\t\t\tthis.options.quit();",
					"\t\t\t\t}",
					"\t\t\t}",
					"\t\t]));"
				].join("\n")
			},
			{
				from: '\t\t\tif (backend.host === void 0 || hostUrl === void 0 || hostCookie === void 0) return Promise.resolve(new Response(null, { status: 503 }));',
				to: [
					'\t\t\tif (url.pathname === "/__dsh-restart") {',
					"\t\t\t\tapp.relaunch();",
					"\t\t\t\tquitWithoutConfirmation();",
					'\t\t\t\treturn Promise.resolve(new Response("restarting", { status: 200 }));',
					"\t\t\t}",
					'\t\t\tif (backend.host === void 0 || hostUrl === void 0 || hostCookie === void 0) return Promise.resolve(new Response(null, { status: 503 }));'
				].join("\n")
			}
		],
		// Doc comments shortened to keep the byte count identical; least useful first.
		donors: [
			"/** Tray icon present for the whole run, not only while the window is hidden. */\n",
			"\t/** @param options - Icon path, locale reader, and the open and quit actions. */\n",
			"\t/** Remove the icon; called once the quit is confirmed so no dead icon outlives the process. */\n",
			"\t/** Rebuild the tooltip and context menu in the current locale. */\n",
			"/** Quit without the task confirmation; the caller has already decided the application must stop. */\n",
			"/** Windows system tray: the always-present way back to a hidden window and the explicit quit entry. */\n"
		]
	}
];

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/**
 * Parses an asar archive header and returns the buffer plus the data base offset.
 * @param file - path to app.asar.
 */
function readArchive(file) {
	const buffer = fs.readFileSync(file);
	const candidates = [
		{ jsonStart: 12, jsonSize: buffer.readUInt32LE(8), base: 8 + buffer.readUInt32LE(4) },
		{ jsonStart: 16, jsonSize: buffer.readUInt32LE(12), base: 16 + buffer.readUInt32LE(12) },
		{ jsonStart: 12, jsonSize: buffer.readUInt32LE(8), base: 12 + buffer.readUInt32LE(8) }
	];
	for (const candidate of candidates) {
		if (candidate.jsonSize <= 0 || candidate.jsonStart + candidate.jsonSize > buffer.length) continue;
		try {
			const json = JSON.parse(buffer.toString("utf8", candidate.jsonStart, candidate.jsonStart + candidate.jsonSize));
			if (json !== null && typeof json === "object" && json.files !== void 0) return { buffer, base: candidate.base, json };
		} catch {}
	}
	throw new Error(`cannot parse the asar header of ${file}`);
}

/**
 * Walks the header index to one entry.
 * @param root - parsed header JSON.
 * @param entryPath - slash separated path inside the archive.
 */
function pick(root, entryPath) {
	let node = root;
	for (const segment of entryPath.split("/")) {
		node = node?.files?.[segment];
		if (node === void 0) throw new Error(`archive entry missing: ${segment}`);
	}
	return node;
}

/** Finds app.asar without being told where it is. */
function locateArchive() {
	const explicit = process.argv.indexOf("--asar");
	if (explicit >= 0) {
		const value = process.argv[explicit + 1];
		if (value === void 0) throw new Error("--asar needs a path");
		return path.resolve(value);
	}
	if (process.env.DSH_ASAR !== void 0 && process.env.DSH_ASAR !== "") return path.resolve(process.env.DSH_ASAR);
	const candidates = [
		path.join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeekHarness", "resources", "app.asar"),
		path.join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeek Harness", "resources", "app.asar"),
		path.join(process.env.ProgramFiles ?? "", "DeepSeekHarness", "resources", "app.asar"),
		path.join(process.env.ProgramFiles ?? "", "DeepSeek Harness", "resources", "app.asar"),
		path.join(os.homedir(), "AppData", "Local", "Programs", "DeepSeekHarness", "resources", "app.asar")
	];
	const hit = candidates.find((candidate) => candidate !== "" && fs.existsSync(candidate));
	if (hit === void 0) throw new Error("cannot find app.asar; pass --asar <path> or set DSH_ASAR");
	return hit;
}

/**
 * Applies the edits and reclaims the inserted bytes from donor comments.
 * @param original - original lib/main.js bytes.
 * @param spec - the fingerprint entry to apply.
 */
function buildPatched(original, spec) {
	const text = original.toString("utf8");
	if (Buffer.byteLength(text, "utf8") !== original.length) throw new Error("lib/main.js is not clean UTF-8");
	let next = text;
	for (const edit of spec.edits) {
		const first = next.indexOf(edit.from);
		if (first < 0) throw new Error("patch anchor not found; this build is not the one the patch was written for");
		if (next.indexOf(edit.from, first + 1) >= 0) throw new Error("patch anchor is not unique");
		next = next.slice(0, first) + edit.to + next.slice(first + edit.from.length);
	}
	let remaining = Buffer.byteLength(next, "utf8") - original.length;
	if (remaining <= 0) throw new Error(`unexpected byte delta ${remaining}`);
	for (const donor of spec.donors) {
		if (remaining <= 0) break;
		if (remaining < donor.length) continue;
		const occurrences = next.split(donor).length - 1;
		if (occurrences !== 1) throw new Error(`donor comment is not unique (${occurrences})`);
		next = next.replace(donor, "");
		remaining -= donor.length;
	}
	if (remaining > 0) {
		for (const donor of spec.donors) {
			if (donor.length <= remaining + 8 || !next.includes(donor)) continue;
			const openIndex = donor.indexOf("/**");
			const prefix = donor.slice(0, openIndex + 3);
			const suffix = donor.endsWith("\n") ? "*/\n" : "*/";
			const targetLength = donor.length - remaining;
			const bodyRoom = targetLength - prefix.length - suffix.length;
			if (bodyRoom < 2) continue;
			let body = donor.slice(openIndex + 3, donor.length - suffix.length).replace(/\*\//g, "* /");
			if (body.length > bodyRoom) body = body.slice(0, bodyRoom);
			body = body.padEnd(bodyRoom, " ");
			const shortened = `${prefix}${body}${suffix}`;
			if (shortened.length !== targetLength) continue;
			next = next.replace(donor, shortened);
			remaining = 0;
			break;
		}
	}
	if (remaining !== 0) throw new Error(`cannot reclaim ${remaining} bytes; refusing to change the archive length`);
	const patched = Buffer.from(next, "utf8");
	if (patched.length !== original.length) throw new Error(`length drift: ${patched.length} vs ${original.length}`);
	return patched;
}

function main() {
	const dryRun = process.argv.includes("--dry-run");
	const archivePath = locateArchive();
	const archive = readArchive(archivePath);
	const entry = pick(archive.json, ENTRY);
	const offset = archive.base + Number(entry.offset);
	const size = Number(entry.size);
	const original = Buffer.from(archive.buffer.subarray(offset, offset + size));
	const digest = sha256(original);

	let packagedVersion = "unknown";
	try {
		const meta = pick(archive.json, "package.json");
		const start = archive.base + Number(meta.offset);
		packagedVersion = JSON.parse(archive.buffer.toString("utf8", start, start + Number(meta.size))).version ?? "unknown";
	} catch {}

	console.log(`archive:  ${archivePath}`);
	console.log(`version:  ${packagedVersion}`);
	console.log(`main.js:  ${size} bytes at ${offset}, sha256 ${digest}`);

	if (original.includes('/__dsh-restart')) {
		console.log("already patched — nothing to do");
		return;
	}
	const spec = SUPPORTED.find((candidate) => candidate.sha256 === digest);
	if (spec === void 0) {
		const known = SUPPORTED.map((candidate) => candidate.version).join(", ");
		throw new Error(
			`this build is not supported (supported: ${known}). The header button keeps working without the patch; ` +
			"open an issue with the sha256 above to get this build added."
		);
	}

	const patched = buildPatched(original, spec);
	console.log(`patched:  ${patched.length} bytes, sha256 ${sha256(patched)}`);
	if (dryRun) {
		console.log("dry run — nothing written");
		return;
	}

	const backupPath = archivePath + BAK_SUFFIX;
	const manifestPath = archivePath + MANIFEST_SUFFIX;
	fs.writeFileSync(backupPath, original);
	fs.writeFileSync(manifestPath, JSON.stringify({
		archive: archivePath,
		entry: ENTRY,
		version: packagedVersion,
		offset,
		size,
		sha256Original: digest,
		sha256Patched: sha256(patched),
		createdAt: new Date().toISOString()
	}, null, 2) + "\n");
	console.log(`backup:   ${backupPath}`);

	const fd = fs.openSync(archivePath, "r+");
	try {
		const current = Buffer.alloc(size);
		fs.readSync(fd, current, 0, size, offset);
		if (sha256(current) !== digest) throw new Error("the archive changed under us; close the app and retry");
		fs.writeSync(fd, patched, 0, size, offset);
		fs.fsyncSync(fd);
		const verify = Buffer.alloc(size);
		fs.readSync(fd, verify, 0, size, offset);
		if (sha256(verify) !== sha256(patched)) throw new Error("verification failed; run restore-asar.cjs");
	} finally {
		fs.closeSync(fd);
	}

	console.log("done — quit the app completely and open it again to load the patch");
	console.log("undo: node scripts/restore-asar.cjs");
}

try {
	main();
} catch (error) {
	console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
