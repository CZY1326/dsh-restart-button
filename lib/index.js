/**
 * Host half of the restart button.
 *
 * It exposes three routes on the DSH web server:
 *   GET  /dsh-restart-button/ping            — liveness probe;
 *   POST /dsh-restart-button/restart         — schedule a stop-and-relaunch of the desktop app;
 *   POST /dsh-restart-button/restart?probe=1 — write the probe marker only, no process is touched.
 *
 * The relaunch is performed by a detached helper that outlives this process: it
 * waits for the response to flush, stops every process of the app, waits for them
 * to be gone, then starts the executable again. No Electron API is involved, so it
 * works without touching app.asar — the optional `scripts/patch-asar.cjs` only
 * upgrades the experience (tray entry + graceful relaunch via `app.relaunch()`).
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const name = "dsh-restart-button";
const inject = ["webServer"];

const PING_PATH = "/dsh-restart-button/ping";
const RESTART_PATH = "/dsh-restart-button/restart";

/** How long the helper waits before killing, so the HTTP reply lands first. */
const KILL_DELAY_SECONDS = 2;

const HELPER_FILE = join(tmpdir(), "dsh-restart-button-helper");
const PROBE_FILE = join(tmpdir(), "dsh-restart-button-probe.txt");
const LOG_FILE = join(tmpdir(), "dsh-restart-button.log");

/**
 * Writes a JSON reply and ends the response.
 * @param response - node http response.
 * @param status - HTTP status code.
 * @param body - serialisable payload.
 */
function sendJson(response, status, body) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	response.end(JSON.stringify(body));
}

/**
 * Resolves the desktop executable this host belongs to.
 * @returns the executable path and its image name, or null on a plain node host.
 */
function desktopExecutable() {
	const override = process.env.DSH_RESTART_EXE;
	const exe = override !== void 0 && override !== "" && existsSync(override) ? override : process.execPath;
	if (typeof exe !== "string" || exe === "") return null;
	const image = exe.split(/[\\/]/).pop() ?? "";
	// `dsh web` runs on a bare node binary; there is no application to relaunch.
	if (/^node(\.exe)?$/i.test(image)) return null;
	return { exe, image };
}

/**
 * Writes the helper script for one restart attempt.
 *
 * Every attempt gets its own file name: cmd.exe reads a batch file by byte
 * offset while it runs, so rewriting a shared helper in place can make the
 * interpreter jump into the middle of a line and loop forever.
 * @param target - executable path and image name.
 * @returns path of the script plus the argv to run it.
 */
function writeHelper(target) {
	const stamp = Date.now().toString(36);
	if (process.platform === "win32") {
		const file = `${HELPER_FILE}-${stamp}.ps1`;
		const quote = (value) => `'${value.replace(/'/g, "''")}'`;
		// Fixed waits, no polling loop: a loop is what turns one stuck restart into a
		// storm of consoles, and the process name is enough to find the app without
		// parsing `tasklist` output.
		const lines = [
			"$ErrorActionPreference = 'SilentlyContinue'",
			`$log = ${quote(LOG_FILE)}`,
			`$exe = ${quote(target.exe)}`,
			`$processName = ${quote(target.image.replace(/\.exe$/i, ""))}`,
			"function Write-RestartLog($message) { Add-Content -LiteralPath $log -Encoding utf8 -Value ('[{0}] {1}' -f (Get-Date -Format s), $message) }",
			"if (-not (Test-Path -LiteralPath $exe)) { Write-RestartLog ('missing executable ' + $exe); exit 1 }",
			"Write-RestartLog 'restart requested'",
			`Start-Sleep -Seconds ${KILL_DELAY_SECONDS}`,
			"Stop-Process -Name $processName -Force -ErrorAction SilentlyContinue",
			`Start-Sleep -Seconds ${KILL_DELAY_SECONDS}`,
			// Starting a second copy while the first is still shutting down is what
			// makes the desktop show its "another instance is running" dead end.
			"if (Get-Process -Name $processName -ErrorAction SilentlyContinue) { Write-RestartLog 'still running after stop; not starting a second copy'; exit 0 }",
			"Write-RestartLog ('starting ' + $exe)",
			"Start-Process -FilePath $exe"
		];
		writeFileSync(file, `${lines.join("\r\n")}\r\n`);
		return {
			file,
			args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", file],
			command: "powershell.exe"
		};
	}
	const file = `${HELPER_FILE}-${stamp}.sh`;
	const lines = [
		`if [ ! -x "${target.exe}" ]; then echo "missing executable ${target.exe}" >> "${LOG_FILE}"; exit 1; fi`,
		`echo "$(date) restart requested" >> "${LOG_FILE}"`,
		`sleep ${KILL_DELAY_SECONDS}`,
		`pkill -f "${target.exe}" >> "${LOG_FILE}" 2>&1`,
		`sleep ${KILL_DELAY_SECONDS}`,
		`nohup "${target.exe}" >> "${LOG_FILE}" 2>&1 &`
	];
	writeFileSync(file, `#!/bin/sh\n${lines.join("\n")}\n`, { mode: 0o755 });
	return { file, args: [file], command: "/bin/sh" };
}

/**
 * Starts the helper in its own process group so killing the app cannot take it down.
 * @param script - command, argv and the script path it runs.
 */
function startHelper(script) {
	const child = spawn(script.command, script.args, { detached: true, stdio: "ignore", windowsHide: true });
	child.unref();
	return child.pid ?? null;
}

/**
 * Host plugin body: registers the liveness probe, the restart trigger and its probe.
 * @param ctx - host root context.
 */
function apply(ctx) {
	ctx.effect(() => {
		const disposers = [
			ctx.webServer.register({
				kind: "exact",
				path: PING_PATH,
				handler: (_request, response) => {
					const target = desktopExecutable();
					sendJson(response, 200, {
						ok: true,
						plugin: name,
						platform: process.platform,
						desktop: target !== null,
						exe: target?.exe ?? null,
						resources: process.resourcesPath ?? null,
						asar: process.resourcesPath === void 0 ? null : join(process.resourcesPath, "app.asar")
					});
				}
			}),
			ctx.webServer.register({
				kind: "exact",
				path: RESTART_PATH,
				handler: (request, response) => {
					// A custom header keeps stray GETs (crawlers, prefetchers, other
					// tabs) from stopping the application; a cross-origin caller cannot
					// set it without a CORS preflight this server never grants.
					if (request.method !== "POST") {
						sendJson(response, 405, { ok: false, error: "method not allowed" });
						return;
					}
					if (request.headers["x-dsh-restart"] !== "1") {
						sendJson(response, 403, { ok: false, error: "missing x-dsh-restart header" });
						return;
					}
					const target = desktopExecutable();
					if (target === null) {
						sendJson(response, 501, {
							ok: false,
							error: "no desktop application to relaunch; set DSH_RESTART_EXE to the executable path"
						});
						return;
					}
					const probe = new URL(request.url ?? "", "http://localhost").searchParams.get("probe") === "1";
					if (probe) {
						// The probe only proves the plugin is mounted and knows its target; it
						// must not open a shell just to write one line.
						try {
							writeFileSync(PROBE_FILE, `probe exe=${target.exe} image=${target.image}\n`);
						} catch (error) {
							sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
							return;
						}
						sendJson(response, 200, { ok: true, scheduled: false, probe: true, exe: target.exe, marker: PROBE_FILE });
						return;
					}
					let pid = null;
					try {
						pid = startHelper(writeHelper(target));
					} catch (error) {
						sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
						return;
					}
					sendJson(response, 200, {
						ok: true,
						scheduled: true,
						probe: false,
						pid,
						exe: target.exe,
						delayMs: KILL_DELAY_SECONDS * 1000,
						marker: null,
						log: LOG_FILE
					});
				}
			})
		];
		return () => {
			for (const dispose of disposers) {
				if (typeof dispose === "function") dispose();
			}
		};
	}, "dsh-restart-button: routes");
}

export { apply, desktopExecutable, inject, name, writeHelper };
