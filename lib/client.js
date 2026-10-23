/**
 * Browser half of the restart button: one circular arrow in the conversation
 * header, immediately left of the open-in-app (file manager / git bash) selector.
 *
 * Two ways to stop and start the app, tried in order:
 *   1. `dsh-app://app/__dsh-restart` — only exists after `scripts/patch-asar.cjs`
 *      has been applied; Electron relaunches the process itself (graceful).
 *   2. `POST /dsh-restart-button/restart` — always available; the host spawns a
 *      detached shell that kills the image and starts it again.
 */
window.__ModuleLoader__.load({
	id: "dsh-restart-button",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsx = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region styles
		const css = [
			".dshrb_button{width:28px;height:28px;flex:none;padding:0;display:inline-flex;align-items:center;justify-content:center;",
			"border-radius:var(--dsw-radius-sm);background:0 0;border:0;cursor:pointer;color:var(--dsw-alias-label-tertiary);",
			"transition:color .12s,background .12s}",
			".dshrb_button:hover,.dshrb_button:focus-visible{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-l1)}",
			".dshrb_button svg{width:15px;height:15px}",
			".dshrb_icon{transition:transform .12s}",
			".dshrb_busy{cursor:progress;color:var(--dsw-alias-label-secondary)}",
			".dshrb_busy .dshrb_icon{animation:dshrb-spin .9s linear infinite}",
			".dshrb_failed{color:var(--dsw-alias-state-error-primary)}",
			"@keyframes dshrb-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}"
		].join("");
		const tagId = "dsh-restart-button/restart.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-restart-button";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const styles = {
			button: "dshrb_button",
			icon: "dshrb_icon",
			busy: "dshrb_busy",
			failed: "dshrb_failed"
		};
		//#endregion
		//#region dictionaries
		const zh = {
			restart: "重启 DeepSeek Harness",
			restartAria: "重启应用：结束当前进程并重新启动",
			restarting: "正在重启…",
			restartFailed: "重启失败：请手动退出后重新打开"
		};
		const en = {
			restart: "Restart DeepSeek Harness",
			restartAria: "Restart the application: quit the current process and start it again",
			restarting: "Restarting…",
			restartFailed: "Restart failed — quit and open the app manually"
		};
		//#endregion
		//#region restart action
		const DIRECT_URL = "dsh-app://app/__dsh-restart";
		const HOST_URL = "/dsh-restart-button/restart";

		/**
		 * Asks for a restart, preferring the graceful shell route when it exists.
		 * A successful direct call tears the renderer down, so the fallback only
		 * runs when this page is still alive to run it.
		 */
		async function requestRestart() {
			try {
				const direct = await fetch(DIRECT_URL, { cache: "no-store" });
				if (direct.ok) return;
			} catch {
				// The shell handled the request and the page is going away.
				return;
			}
			const fallback = await fetch(HOST_URL, {
				method: "POST",
				cache: "no-store",
				headers: { "x-dsh-restart": "1" }
			});
			if (!fallback.ok) throw new Error(`restart rejected (${fallback.status})`);
		}

		/**
		 * Circular-arrow restart control placed left of the open-in-app selector.
		 * @param props - slot props; only the namespaced translator is used.
		 */
		function RestartAction({ t }) {
			const [phase, setPhase] = (0, react.useState)("idle");
			const onClick = (0, react.useCallback)(() => {
				setPhase("busy");
				requestRestart().then(() => {
					window.setTimeout(() => {
						setPhase("idle");
					}, 2000);
				}, () => {
					window.setTimeout(() => {
						setPhase("failed");
					}, 1200);
					window.setTimeout(() => {
						setPhase("idle");
					}, 4200);
				});
			}, []);
			const label = phase === "busy" ? t("restarting") : phase === "failed" ? t("restartFailed") : t("restart");
			const className = [
				styles.button,
				phase === "busy" ? styles.busy : "",
				phase === "failed" ? styles.failed : ""
			].filter((entry) => entry !== "").join(" ");
			return (0, jsx.jsx)(primitives.Tooltip, {
				label,
				side: "bottom",
				delayMs: 500,
				children: (0, jsx.jsx)(primitives.Button, {
					size: "sm",
					className,
					"aria-label": t("restartAria"),
					"data-dsh-restart": true,
					onClick,
					children: (0, jsx.jsx)(primitives.IconRefreshOutlineRegular, { className: styles.icon })
				})
			});
		}
		//#endregion
		//#region plugin body
		/** Slot registry and dictionaries. */
		const inject = ["slots", "locale"];
		/**
		 * Registers the dictionaries and the header action. The action is skipped
		 * outside the desktop shell, where nothing can relaunch the app.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			if (typeof location !== "undefined" && location.protocol !== "dsh-app:") return;
			ctx.effect(() => ctx.locale.register("restartButton", {
				zh,
				en
			}), "dsh-restart-button: dictionaries");
			// `header.utilities` is the right-hand cluster; `order: -20` sorts before
			// open-in-app (-10), so the arrow sits directly left of that selector.
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "restart-app",
				order: -20,
				locale: "restartButton"
			}, RestartAction));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
