/**
 * Host half of the restart button.
 *
 * It exposes three routes on the DSH web server:
 *   GET  /dsh-restart-button/ping           — liveness probe;
 *   POST /dsh-restart-button/restart        — schedule a stop-and-relaunch of the desktop app;
 *   POST /dsh-restart-button/restart?probe=1 — same plumbing, but the helper only writes a
 *                                              marker file instead of killing anything.
 *
 * The relaunch is performed by a detached helper that outlives this process: it
 * waits for the response to flush, kills every process whose image is the app
 * executable (main, renderers, GPU and this host all share it), then starts the
 * executable again. No Electron API is involved, so this works without touching
 * app.asar — the optional `scripts/patch-asar.cjs` only upgrades the experience
 * (tray entry + graceful relaunch via `app.relaunch()`).
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
 * Writes the helper script next to the temp directory.
 * @param target - executable path and image name.
 * @param probe - when true the helper only records that it ran.
 * @returns path of the script plus the argv to run it.
 */
function writeHelper(target, probe) {
	if (process.platform === "win32") {
		const lines = ["@echo off", "setlocal"];
		if (probe) {
			lines.push(`echo probe exe=${target.exe} image=${target.image}>"${PROBE_FILE}"`);
		} else {
			// Never kill the app unless we know what to start afterwards: otherwise the
			// user is left with a closed application and nothing to reopen it.
			lines.push(
				`set "EXE=${target.exe}"`,
				`set "IMG=${target.image}"`,
				`if not exist "%EXE%" (`,
				`  echo [%DATE% %TIME%] missing executable "%EXE%">>"${LOG_FILE}"`,
				"  exit /b 1",
				")",
				`echo [%DATE% %TIME%] restart requested>>"${LOG_FILE}"`,
				`ping -n ${KILL_DELAY_SECONDS + 1} 127.0.0.1 >nul`,
				`taskkill /F /IM "%IMG%" >>"${LOG_FILE}" 2>&1`,
				"set /a tries=0",
				":dshrbwait",
				"set /a tries+=1",
				`tasklist /FI "IMAGENAME eq %IMG%" | find /I "%IMG%" >nul`,
				"if errorlevel 1 goto dshrbstart",
				"if %tries% GEQ 15 goto dshrbstart",
				"ping -n 2 127.0.0.1 >nul",
				"goto dshrbwait",
				":dshrbstart",
				`echo [%DATE% %TIME%] starting "%EXE%">>"${LOG_FILE}"`,
				'start "" "%EXE%"'
			);
		}
		const file = `${HELPER_FILE}.cmd`;
		writeFileSync(file, `${lines.join("\r\n")}\r\n`);
		return { file, args: ["/c", file], command: "cmd.exe" };
	}
	const file = `${HELPER_FILE}.sh`;
	const lines = probe
		? [`echo "probe exe=${target.exe} image=${target.image}" > "${PROBE_FILE}"`]
		: [
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
					let pid = null;
					try {
						pid = startHelper(writeHelper(target, probe));
					} catch (error) {
						sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
						return;
					}
					sendJson(response, 200, {
						ok: true,
						scheduled: !probe,
						probe,
						pid,
						exe: target.exe,
						delayMs: KILL_DELAY_SECONDS * 1000,
						marker: probe ? PROBE_FILE : null,
						log: probe ? null : LOG_FILE
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
