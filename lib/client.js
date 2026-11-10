/**
 * dsh-confirm-mode — Client half (web bundle).
 *
 * One surface over two Host values: the confirm-mode toggle （确认模式） in the
 * composer tool row seat `conversation.input.left` — the seat right next to
 * the permission (access mode) selector. It reads and writes the CURRENT
 * SESSION's mode, so switching there never changes what the next session
 * opens with; the DEFAULT mode is the plugin's own configuration
 * (Settings → Plugins → dsh-confirm-mode).
 *
 * Confirm mode is independent of 创造模式 (creation mode) and of DSH's own
 * permission presets: while it is ON, every sensitive-permission invocation —
 * a sandbox escalation, or a tool call that requests an elevated
 * `sandbox_permissions` — is handed to the click-to-approve composer so the
 * user confirms it one call at a time, and nothing is auto-approved.
 *
 * Both values are read and written through the Host control route
 * (`GET/POST /confirm-mode`, same-origin fetch): the route keeps the settings
 * RPC surface out of the plugin, and a compose-time control route keeps the
 * mode read/write self-contained.
 *
 * i18n: registers the "confirm-mode" dictionary (zh/en) with the DSH locale
 * service; slot owners inject the bound `t` via the `locale` registration
 * option, so all copy follows the DSH UI language automatically.
 *
 * Bundle format: `window.__ModuleLoader__.load({ id, factory })` — the DSH web
 * client module system (CJS-style factory; "react" resolves to the platform
 * seed module). No bundler is required to produce this file.
 */
window.__ModuleLoader__.load({
	id: "dsh-confirm-mode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var h = react.createElement;
		var useEffect = react.useEffect;
		var useState = react.useState;
		var useCallback = react.useCallback;

		/** Locale dictionary namespace owned by this plugin. */
		var NS = "confirm-mode";
		/** Slot cell key in conversation.input.left. */
		var CONFIRM_MODE_TOGGLE_ID = "confirm-mode-toggle";
		/** Host control route (same origin as the served GUI). */
		var ROUTE_PATH = "/confirm-mode";
		/** Mode values, mirrored from the Host half. */
		var OFF = "off";
		var ON = "on";

		/** Chinese dictionary (also the no-locale-service fallback). */
		var zh = {
			"mode.off": "默认",
			"mode.on": "确认模式",
			"mode.unknown": "读取中…",
			"title.off": "确认模式：关闭 —— 敏感权限按 DSH 默认策略处理",
			"title.on": "确认模式：已开启 —— 每次调用敏感权限都会要求你逐条确认，不再自动审批",
			"title.unknown": "确认模式：无法与 DSH 通信，暂不可切换",
			"title.loading": "确认模式：正在读取当前设置…",
			"aria.off": "确认模式，当前会话：关闭",
			"aria.on": "确认模式，当前会话：已开启",
			"hint.on": "每次调用敏感权限都会要求逐条确认"
		};

		/** English dictionary. */
		var en = {
			"mode.off": "Default",
			"mode.on": "Confirm",
			"mode.unknown": "Reading…",
			"title.off": "Confirm mode: off — sensitive permissions follow DSH's default policy",
			"title.on": "Confirm mode: on — every sensitive-permission invocation asks you to confirm, one call at a time; nothing is auto-approved",
			"title.unknown": "Confirm mode: cannot reach DSH, switching is unavailable",
			"title.loading": "Confirm mode: reading the current setting…",
			"aria.off": "Confirm mode, current session: off",
			"aria.on": "Confirm mode, current session: on",
			"hint.on": "Every sensitive-permission invocation asks for confirmation"
		};

		/** The current UI language ("zh" or "en"). */
		function languageOf(t) {
			if (t && typeof t === "object" && typeof t.locale === "string") {
				var id = t.locale;
				return id === "en" || id.indexOf("en-") === 0 || id.indexOf("en_") === 0 ? "en" : "zh";
			}
			return "zh";
		}

		/**
		 * Simplified fallback interpolation (no locale service): the plugin's
		 * dictionaries carry no parameters today, but the shape stays so a
		 * future key can add one without touching the call sites.
		 */
		function fallbackT(key, params) {
			var text = zh[key] || key;
			if (params) {
				for (var name of Object.keys(params)) {
					text = text.split("{" + name + "}").join(String(params[name]));
				}
			}
			return text;
		}

		/** A shield glyph: the "user confirms every sensitive call" metaphor. */
		function ShieldGlyph(props) {
			return h("svg", {
				viewBox: "0 0 24 24",
				width: 14,
				height: 14,
				fill: "none",
				stroke: "currentColor",
				"stroke-width": 2,
				"stroke-linecap": "round",
				"stroke-linejoin": "round",
				"aria-hidden": true,
				style: { flex: "0 0 auto", pointerEvents: "none" }
			},
				h("path", { d: "M12 3l7 3v6c0 4-3 7.5-7 9-4-1.5-7-5-7-9V6l7-3z" }),
				props && props.on ? h("path", { d: "M9 12l2 2 4-4" }) : null
			);
		}

		/**
		 * One confirm-mode toggle for the current session.
		 *
		 * The mode is the CURRENT SESSION's own value: switching it never
		 * changes what the next session opens with (that is the plugin's
		 * default configuration). Reads and writes go to the Host control
		 * route addressed by `sessionId`.
		 */
		function ConfirmModeToggle(props) {
			var sessionId = props && props.sessionId ? props.sessionId : null;
			var t = props && typeof props.t === "function" ? props.t : fallbackT;

			var state = useState({ value: null, loading: true, error: false });
			var current = state[0].value;
			var loading = state[0].loading;
			var failed = state[0].error;
			var setState = state[1];

			useEffect(function () {
				if (!sessionId) {
					setState({ value: null, loading: false, error: false });
					return undefined;
				}
				var disposed = false;
				setState({ value: null, loading: true, error: false });
				fetch(ROUTE_PATH + "?session=" + encodeURIComponent(sessionId), {
					method: "GET",
					credentials: "same-origin",
					headers: { accept: "application/json" }
				}).then(function (res) {
					return res.ok ? res.json() : Promise.reject(new Error("http " + res.status));
				}).then(function (body) {
					if (disposed) return;
					var next = body && body.ok ? body.mode : null;
					setState({ value: next === ON ? ON : next === OFF ? OFF : null, loading: false, error: next === null });
				}).catch(function () {
					if (!disposed) setState({ value: null, loading: false, error: true });
				});
				return function () {
					disposed = true;
				};
			}, [sessionId]);

			var onToggle = useCallback(function () {
				if (!sessionId || loading) return;
				var next = current === ON ? OFF : ON;
				setState({ value: current, loading: true, error: false });
				fetch(ROUTE_PATH + "?session=" + encodeURIComponent(sessionId), {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ mode: next })
				}).then(function (res) {
					return res.ok ? res.json() : Promise.reject(new Error("http " + res.status));
				}).then(function (body) {
					var value = body && body.ok && (body.mode === ON || body.mode === OFF) ? body.mode : null;
					if (value === null) return Promise.reject(new Error("bad-response"));
					if (value !== next) return Promise.reject(new Error("not-applied"));
					setState({ value: value, loading: false, error: false });
				}).catch(function () {
					setState({ value: current, loading: false, error: true });
				});
			}, [sessionId, current, loading]);

			var isOn = current === ON;
			var unknown = current === null;
			var titleKey = loading ? "title.loading" : unknown ? "title.unknown" : isOn ? "title.on" : "title.off";
			var labelKey = loading ? "mode.unknown" : isOn ? "mode.on" : unknown ? "mode.unknown" : "mode.off";
			var ariaKey = isOn ? "aria.on" : "aria.off";
			var label = t(labelKey);
			var title = t(titleKey);
			var aria = t(ariaKey, { mode: label });

			return h("button", {
				type: "button",
				className: "dsh-confirm-mode-toggle" + (isOn ? " is-on" : "") + (failed ? " is-error" : ""),
				onClick: onToggle,
				disabled: !sessionId || loading,
				"aria-pressed": isOn,
				"aria-label": aria,
				title: title,
				"data-dsh-confirm-mode": ""
			},
				h(ShieldGlyph, { on: isOn }),
				h("span", { className: "dsh-confirm-mode-toggle-label" }, label)
			);
		}

		/* ── styles ────────────────────────────────────────────────────
		 * The DSH permission control is a small pill in the composer tool row:
		 * these rules mirror that shape and size and take every color from the
		 * host's theme tokens, so the button follows light/dark and brand
		 * changes like any built-in control. Tokens are the only shared
		 * styling dependency: a renamed token degrades appearance but never
		 * breaks rendering. Renamed under this plugin's own prefix.
		 */
		var CONFIRM_MODE_CSS = [
			".dsh-confirm-mode-toggle {",
			"  display: inline-flex; align-items: center; gap: 6px;",
			"  height: 28px; padding: 0 10px; margin: 0;",
			"  border-radius: 9999px;",
			"  border: 1px solid var(--dsw-alias-border-subtle, rgba(120,120,130,0.32));",
			"  background: var(--dsw-alias-fill-quaternary, transparent);",
			"  color: var(--dsw-alias-text-secondary, inherit);",
			"  font-size: 12px; line-height: 1;",
			"  cursor: pointer; user-select: none;",
			"  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;",
			"}",
			".dsh-confirm-mode-toggle:hover:not(:disabled) {",
			"  background: var(--dsw-alias-fill-tertiary, rgba(120,120,130,0.12));",
			"}",
			".dsh-confirm-mode-toggle:disabled {",
			"  cursor: default; opacity: 0.55;",
			"}",
			".dsh-confirm-mode-toggle.is-on {",
			"  border-color: color-mix(in srgb, var(--dsw-alias-color-warning, #d97706) 55%, transparent);",
			"  background: color-mix(in srgb, var(--dsw-alias-color-warning, #d97706) 12%, transparent);",
			"  color: var(--dsw-alias-color-warning, #b45309);",
			"}",
			".dsh-confirm-mode-toggle.is-error {",
			"  border-color: var(--dsw-alias-color-danger, #dc2626);",
			"}",
			".dsh-confirm-mode-toggle-label {",
			"  white-space: nowrap;",
			"}"
		].join("\n");

		var name = "dsh-confirm-mode";
		var inject = ["slots", "locale"];

		function apply(ctx) {
			// Register the dictionary so the slot's bound `t` resolves this
			// plugin's keys; the registration is disposed with the plugin.
			ctx.locale.register(NS, { zh: zh, en: en });

			// One stylesheet, owned and removed by this plugin.
			var style = document.createElement("style");
			style.setAttribute("data-dsh-confirm-mode", "");
			style.textContent = CONFIRM_MODE_CSS;
			document.head.appendChild(style);
			ctx.effect(function () {
				return function () {
					style.remove();
				};
			}, "dsh-confirm-mode: styles");

			// Register the toggle into the seat beside the permission selector.
			// `locale: NS` makes the owner inject the bound translate function
			// as `t`, and `sessionId` / `useProjection` reach the component as
			// the slot owner's own props.
			ctx.slots.inject("conversation.input.left", function () {
				return ctx.slots.register({
					name: "conversation.input.left",
					id: CONFIRM_MODE_TOGGLE_ID,
					order: 60,
					label: "确认模式",
					locale: NS
				}, ConfirmModeToggle);
			});
		}

		module.exports = { name: name, inject: inject, apply: apply };
		return module.exports;
	}
});
