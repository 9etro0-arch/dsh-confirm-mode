/**
 * dsh-confirm-mode — Host half.
 *
 * Adds an independent session mode — 「确认模式」(Confirm Mode) — that sits
 * beside DSH's own permission presets (Read Only / Workspace Write / Full
 * Access) and beside 创造模式 (creation mode). While it is ON for a session,
 * every invocation of a SENSITIVE PERMISSION must be confirmed by the user
 * one call at a time: nothing is auto-approved, and nothing is silently
 * auto-rejected either — each ask is routed to the composed answerers (the
 * GUI approval composer) so the user decides every single time.
 *
 * What counts as "invoking a sensitive permission":
 *
 * 1. A sandbox ESCALATION — the one-shot widening that lets a file operation
 *    or a command leave the workspace. `@deepseek-ai/dsh-sandbox` requests
 *    its decision with the reason `escalate sandbox to <mode>: <purpose>`,
 *    which is exactly the string DSH's own tools (`dsh-tool-bash`,
 *    `dsh-tool-pwsh`, `dsh-tool-fs`) produce. This is the canonical
 *    sensitive-permission invocation, and this plugin never settles it: it is
 *    always handed to the next answerer, which in the Web GUI is the
 *    click-to-approve composer.
 * 2. A tool execution that REQUESTS an elevated sandbox mode through its own
 *    `sandbox_permissions` argument (the opt-in widening the model-facing
 *    bash/pwsh/edit/write tools accept). A call carrying that argument is
 *    asking for a wider fence.
 *
 *    The two are deliberately NOT stacked into a double prompt. When the
 *    requested mode is STRICTLY WIDER than the session's effective mode, the
 *    tool's own escalation will request approval and the answerer above
 *    guarantees it reaches the user — so the pre-execute gate stands down.
 *    When the requested mode is already covered by the session's effective
 *    mode (the Full Access preset), no escalation ever happens and no prompt
 *    would ever appear — that silent case is exactly the one the gate takes,
 *    which is what makes the mode work where DSH otherwise asks nothing.
 * 3. A call to a tool named in the configurable `sensitiveTools` list.
 *
 * The gate returns `{ kind: "ask", ... }` from `tools/pre-execute`: the
 * harness then calls `approval.request()`, which dispatches the
 * `approval/request` waterfall to the composed answerers. `allowed-once` is
 * the only grant and it is good for exactly one call, so the user must
 * confirm again on the next sensitive invocation. That is "每次都要求用户确认".
 *
 * One extra step makes the promise hold under every permission preset: while
 * the mode is ON, the session's approval policy is kept at `ask`. Under DSH's
 * `never` policy (the Full Access preset) `ApprovalService` resolves every
 * request to `rejected` BEFORE any answerer runs, which would silently deny
 * instead of asking. The policy is corrected on activation, on each new
 * agent, and — when a preset switch re-applied `never` — on the next gated
 * call, and only then, so the durable log gains one `approval/policy` event
 * per correction rather than one per call.
 *
 * Two storage locations, both immediately effective and persistent:
 *
 * - DEFAULT mode: this plugin's `Config.defaultMode`, a `.volatile()` field
 *   whose live reference DSH 0.1.7+ projects into the settings page; writes
 *   from the route go through `configEditor.edit` and land in the profile
 *   patch, so the settings form and this route edit the same value.
 * - SESSION mode: `$DSH_HOME/confirm-mode/sessions.json`, a small JSON file
 *   this plugin owns — per-session runtime state keyed by an open-ended id
 *   set does not belong in the profile patch.
 *
 * The client half (lib/client.js) renders the toggle button in the composer
 * tool row seat `conversation.input.left` — the seat right next to the
 * permission (access mode) selector — and reads/writes both values through
 * the same small HTTP route (`GET/POST /confirm-mode`), which keeps the
 * settings RPC surface out of the plugin.
 *
 * On a mode change, the agents whose effective mode actually moved are
 * notified via an injected message.
 *
 * Dependencies: `@deepseek-ai/schemastery` is the only host package this half
 * imports, and the notification message is built here rather than by
 * importing a message factory, so no versioned `@deepseek-ai/dsh-*` package
 * is declared or resolved — the manifest then carries no host-version range
 * that a newer DSH can fall outside of.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name (also the bundle row id and the entry id). */
export const name = "dsh-confirm-mode";

/**
 * Required services: only the public `webServer` the control route is
 * registered on. Everything else (`approval`, `agents`, `sessions`,
 * `sessionProjections`, `shell`, `configEditor`) is consumed through `ctx.get`
 * because a deployment without the approval seam still gets the pre-execute
 * gate's degrade-to-deny behavior — requiring it would keep the whole plugin
 * unmounted on a host that composes no answerers at all.
 */
export const inject = ["webServer"];

/** Field name of the default mode inside the plugin's own configuration. */
export const DEFAULT_MODE_FIELD = "defaultMode";
/** Field name of the always-sensitive tool list inside the configuration. */
export const SENSITIVE_TOOLS_FIELD = "sensitiveTools";

/** Mode OFF: DSH's own permission/approval behaviour, untouched. */
export const OFF = "off";
/** Mode ON: every sensitive-permission invocation asks the user, one by one. */
export const ON = "on";
/** Every mode this plugin can put a session in. */
export const MODES = [OFF, ON];
/** Mode every unresolved read falls back to (the fail-closed default). */
export const DEFAULT_MODE = OFF;

/** Sandbox modes, least to most permissive (the fence a call asks to widen). */
export const SANDBOX_RANK = Object.freeze({ "read-only": 0, "workspace-write": 1, "danger-full-access": 2 });
/** The approval policy this mode keeps in force while it is ON. */
export const ASK_POLICY = "ask";
/** The approval policy this mode must not let stand while it is ON. */
export const NEVER_POLICY = "never";

/**
 * The sandbox-escalation ask, as `@deepseek-ai/dsh-sandbox` spells it:
 * `escalate sandbox to <mode>: <purpose>`. An approval request carries agent,
 * tool name, call id, reason and signal — nothing that says what KIND of ask
 * it is. This prefix is therefore the only signal that separates a privilege
 * escalation from an ordinary approval.
 */
export const ESCALATION_REASON = /^escalate sandbox to [^:]+:/;

/**
 * Whether a request is a sandbox escalation.
 * @param req - the pending approval request.
 * @returns true when the request widens the sandbox for one call.
 */
export function isEscalationRequest(req) {
	return typeof req?.reason === "string" && ESCALATION_REASON.test(req.reason);
}

/**
 * Producer kind this plugin stamps on the messages it injects.
 *
 * DSH 0.1.7's session format v4 admits only a PRODUCER-OWNED source kind and
 * refuses the retired wrapper `{ kind: "plugin", plugin: … }` outright. The
 * current shape is the producer's own name — the same convention first-party
 * producers use — and it reads the exported plugin {@link name} so the two
 * cannot drift apart.
 */
export const MESSAGE_SOURCE = Object.freeze({ kind: name });

/**
 * Deep-freeze an object graph in place, cycle-safe.
 *
 * A message handed to `agent.inject()` is committed to the session log, so it
 * is published as an immutable snapshot: every reachable enumerable child is
 * frozen before the agent can see it. The graph is always plugin-built JSON
 * (content blocks plus the source tag), so no live object such as an
 * AbortSignal is reachable from it.
 * @param value - the value to freeze.
 * @returns the same value.
 */
export function deepFreeze(value) {
	if (value === null || typeof value !== "object") return value;
	const seen = new WeakSet();
	const pending = [value];
	while (pending.length > 0) {
		const node = pending.pop();
		if (node === null || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		for (const key of Object.keys(node)) pending.push(node[key]);
	}
	return value;
}

/**
 * Build one identified, immutable user-role message.
 *
 * Reproduced here — four lines over `node:crypto` — so the plugin declares
 * and resolves no versioned harness package: a host-version range in the
 * manifest is what a newer DSH falls outside of, and the identity rule it
 * encodes (a stable `id` per durable message) is a session-log property, not
 * a library one.
 * @param input - the message content and its producer-owned source tag.
 * @returns a frozen user message with a fresh identity.
 */
export function createUserMessage(input) {
	return deepFreeze({
		...structuredClone(input),
		id: randomUUID(),
		role: "user"
	});
}

/**
 * The session an agent belongs to.
 *
 * DSH 0.2.0 narrowed `Agent` to its own id (the session id), while older hosts
 * exposed the session object; both are read so the gate and the notice
 * address the same value on either generation.
 * @param agent - an Agent, or undefined.
 * @returns the session id, or undefined when the agent carries none.
 */
export function sessionIdOf(agent) {
	if (agent === null || typeof agent !== "object") return undefined;
	if (typeof agent.id === "string" && agent.id.length > 0) return agent.id;
	const session = agent.session;
	if (session !== null && typeof session === "object" && typeof session.id === "string" && session.id.length > 0) return session.id;
	return undefined;
}

/**
 * The plugin's own configuration (DSH 0.1.7+).
 *
 * `defaultMode` is marked `.volatile()` wherever schemastery supports it: the
 * loader then keeps this plugin mounted and updates the reference in place
 * when the profile patch changes, which is what lets the settings page write
 * the default and this half observe it live.
 *
 * `sensitiveTools` names tools whose EVERY call is treated as a sensitive
 * permission while the mode is ON — the model-facing mutators that can change
 * the machine beyond the workspace fence.
 */
const defaultModeField = z.union(MODES).default(DEFAULT_MODE);
const sensitiveToolsField = z.array(z.string()).default([]);
export const Config = z.object({
	[DEFAULT_MODE_FIELD]: typeof defaultModeField.volatile === "function" ? defaultModeField.volatile() : defaultModeField,
	[SENSITIVE_TOOLS_FIELD]: typeof sensitiveToolsField.volatile === "function" ? sensitiveToolsField.volatile() : sensitiveToolsField
});

/** Control route path served by this plugin. */
export const ROUTE_PATH = "/confirm-mode";

/** Directory under the DSH home that holds this plugin's own state. */
export const SESSION_STORE_DIR = "confirm-mode";
/** File inside {@link SESSION_STORE_DIR} holding the per-session modes. */
export const SESSION_STORE_FILE = "sessions.json";
/** Format version of the session store document. */
export const SESSION_STORE_VERSION = 1;

/**
 * Session addresses this route and the store refuse. A session id becomes the
 * KEY of an entry in the session map, and these three are the keys whose
 * assignment rewrites a prototype instead of creating an entry — the write
 * would be silently dropped rather than stored, so the address is refused
 * instead of accepted and ignored.
 */
export const RESERVED_SESSION_KEYS = ["__proto__", "constructor", "prototype"];

/**
 * Whether an address names a session this route may write.
 * @param value - the raw `session` query parameter.
 * @returns true when the value can key a session entry.
 */
export function isSessionAddress(value) {
	return typeof value === "string" && value.length > 0 && !RESERVED_SESSION_KEYS.includes(value);
}

/**
 * Keep only the entries of a session map that this plugin can store and use.
 * @param value - any parsed `sessions` value.
 * @returns a fresh map with reserved keys and out-of-vocabulary modes dropped.
 */
export function sanitizeSessions(value) {
	const out = {};
	if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
	for (const [key, mode] of Object.entries(value)) {
		if (isSessionAddress(key) && MODES.includes(mode)) out[key] = mode;
	}
	return out;
}

/**
 * Parse a {@link SESSION_STORE_FILE} document.
 * @param text - raw file contents.
 * @returns the session map, or null when the document is not a JSON object.
 */
export function parseSessionStore(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	// Accept both the versioned envelope and a bare { sessionId: mode } map.
	const sessions = parsed.sessions !== null && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions)
		? parsed.sessions
		: parsed;
	return sanitizeSessions(sessions);
}

/**
 * Absolute path of this plugin's session store.
 *
 * The app-boot `dshHomePath` service is the harness's own resolver and is used
 * when composed; otherwise the documented precedence is repeated here
 * (`$DSH_HOME`, then `~/.dsh`) so the store never lands somewhere the harness
 * would not look.
 * @param ctx - plugin context.
 * @returns the absolute path of the store file.
 */
export function sessionStorePath(ctx) {
	const homePath = ctx !== undefined && ctx !== null && typeof ctx.get === "function" ? ctx.get("dshHomePath") : undefined;
	if (typeof homePath === "function") {
		try {
			return homePath(SESSION_STORE_DIR, SESSION_STORE_FILE);
		} catch {
			// A host whose resolver rejects these segments falls through to the
			// documented default rather than failing the whole plugin.
		}
	}
	const configured = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
	const home = configured.length > 0 ? configured : join(homedir(), ".dsh");
	return join(home, SESSION_STORE_DIR, SESSION_STORE_FILE);
}

/**
 * Whether one tool execution REQUESTS an elevated sandbox mode through its
 * own `sandbox_permissions` argument — the opt-in widening the model-facing
 * bash/pwsh/edit/write tools accept. A call carrying that argument is asking
 * for a wider fence, which is a sensitive-permission invocation.
 *
 * The value may be a string (`"workspace-write"`, `"danger-full-access"`) or a
 * structured `{ mode, justification }` object depending on the tool; both are
 * recognised, and any truthy value under the key counts.
 * @param args - the parsed tool arguments of the pending execution.
 * @returns true when the call asks for a wider sandbox mode.
 */
export function requestsSandboxPermissions(args) {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
	const value = args["sandbox_permissions"];
	if (value === undefined || value === null) return false;
	if (typeof value === "string") return value.length > 0;
	if (typeof value === "object") {
		const mode = value["mode"];
		if (typeof mode === "string") return mode.length > 0;
		// Any non-empty structured request still declares a widening.
		return Object.keys(value).length > 0;
	}
	return false;
}

/**
 * The sandbox mode one execution explicitly asks for, when it names one.
 * @param args - the parsed tool arguments of the pending execution.
 * @returns a sandbox mode string, or null when the request names none.
 */
export function requestedSandboxMode(args) {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
	const value = args["sandbox_permissions"];
	if (typeof value === "string") return value;
	if (value !== null && typeof value === "object" && typeof value["mode"] === "string") return value["mode"];
	return null;
}

/**
 * Look up one live Session by id.
 * @param ctx - plugin context.
 * @param sessionId - the session id, when known.
 * @returns the Session, or undefined when it cannot be resolved.
 */
function sessionOf(ctx, sessionId) {
	if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
	const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
	if (sessions === undefined || sessions === null) return undefined;
	try {
		if (typeof sessions.get === "function") return sessions.get(sessionId) ?? undefined;
		if (typeof sessions.list === "function") {
			for (const session of sessions.list()) {
				if (session !== null && typeof session === "object" && session.id === sessionId) return session;
			}
		}
	} catch {
		// An unreadable store degrades to "unknown" and the gate fails closed.
	}
	return undefined;
}

/**
 * One session's folded permission state, when the permission-presets
 * projection is mounted. Holds the session's own `sandbox` and `approval`
 * knob overrides; `undefined` means the projection is unavailable.
 * @param ctx - plugin context.
 * @param session - a live Session.
 * @returns the permission state, or undefined.
 */
function permissionStateOf(ctx, session) {
	if (session === undefined || session === null) return undefined;
	const projections = typeof ctx.get === "function" ? ctx.get("sessionProjections") : undefined;
	if (projections === undefined || projections === null || typeof projections.stateOf !== "function") return undefined;
	try {
		return projections.stateOf(session, "permissions");
	} catch {
		return undefined;
	}
}

/**
 * The sandbox mode this session actually runs under: its own override, else
 * the composed shell default. Used to tell a widening request (which the
 * tool's own escalation will ask for) from a request the session already
 * covers (which produces no ask at all and must be gated here).
 * @param ctx - plugin context.
 * @param sessionId - the session id, when known.
 * @returns a sandbox mode string, or null when it cannot be resolved.
 */
function effectiveSandboxMode(ctx, sessionId) {
	const session = sessionOf(ctx, sessionId);
	if (session !== undefined) {
		const state = permissionStateOf(ctx, session);
		if (state !== null && typeof state === "object" && typeof state.sandbox === "string") return state.sandbox;
	}
	const shell = typeof ctx.get === "function" ? ctx.get("shell") : undefined;
	if (shell !== null && typeof shell === "object" && typeof shell.sandboxMode === "string") return shell.sandboxMode;
	return null;
}

/**
 * The approval policy this session actually runs under: its own override,
 * else the approval service's composed default.
 * @param ctx - plugin context.
 * @param sessionId - the session id, when known.
 * @returns `"ask"` or `"never"`, or null when it cannot be resolved.
 */
function effectiveApprovalPolicy(ctx, sessionId) {
	const session = sessionOf(ctx, sessionId);
	if (session !== undefined) {
		const state = permissionStateOf(ctx, session);
		if (state !== null && typeof state === "object" && (state.approval === "ask" || state.approval === "never")) return state.approval;
		const approval = typeof ctx.get === "function" ? ctx.get("approval") : undefined;
		if (approval !== null && typeof approval === "object" && typeof approval.overrideOf === "function") {
			try {
				const override = approval.overrideOf(session);
				if (override === "ask" || override === "never") return override;
			} catch {
				// Unreadable override falls through to the composed default.
			}
		}
	}
	const approval = typeof ctx.get === "function" ? ctx.get("approval") : undefined;
	if (approval !== null && typeof approval === "object" && approval.config !== null && typeof approval.config === "object") {
		const policy = approval.config.policy;
		if (policy === "ask" || policy === "never") return policy;
	}
	return null;
}

/** Loader entry id of the locale plugin, whose config carries the UI language. */
const LOCALE_ENTRY_ID = "locale";

/**
 * Whether the DSH UI language is English.
 *
 * The locale preference moved with the rest of the settings: DSH <= 0.1.6
 * serves it as the `locale` settings namespace, 0.1.7+ as the `locale` plugin
 * entry's own `preference` config field. Both are read before the Chinese
 * default this plugin uses.
 * @param ctx - plugin context.
 * @returns true when English was explicitly selected.
 */
function prefersEnglish(ctx) {
	try {
		const settings = typeof ctx.get === "function" ? ctx.get("settings") : undefined;
		if (settings !== undefined && settings !== null && typeof settings.get === "function") {
			const locale = settings.get("locale");
			if (locale !== null && typeof locale === "object" && typeof locale.preference === "string") return locale.preference === "en";
		}
	} catch {
		// A settings service that does not serve this namespace is not an error.
	}
	try {
		const editor = typeof ctx.get === "function" ? ctx.get("configEditor") : undefined;
		if (editor === undefined || editor === null || typeof editor.configuration !== "function") return false;
		for (const row of editor.configuration()) {
			if (row === undefined || row === null || row?.entry?.options?.id !== LOCALE_ENTRY_ID) continue;
			const stored = row.override?.preference ?? row.inherited?.preference;
			if (typeof stored === "string") return stored === "en";
		}
	} catch {
		// An unreadable configuration is not an error for a notice's language.
	}
	return false;
}

/** Whether an HTTP request arrives from a loopback authority (defense for 0.0.0.0 deployments). */
function isLoopbackRequest(req) {
	const host = req.headers.host;
	if (typeof host !== "string") return false;
	try {
		const hostname = new URL(`http://${host}`).hostname;
		if (hostname === "localhost" || hostname === "[::1]") return true;
		const parts = hostname.split(".");
		return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
	} catch {
		return false;
	}
}

/** Read the full request body (bounded). */
function readBody(req, maxBytes = 65536) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > maxBytes) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/**
 * The per-session mode map, backed by {@link sessionStorePath}.
 *
 * Reads are synchronous and lazily load the file once, because the gates
 * resolve a mode inside a waterfall and must never await I/O there. The file
 * is small (one short entry per session that ever switched) and is written
 * atomically — temporary file plus rename — so a crash mid-write cannot leave
 * a half-written map behind.
 *
 * Every failure degrades rather than throws: an unreadable or malformed store
 * starts empty (and says so in the log), and a failed write leaves the
 * previous value in memory so the route can honestly answer that nothing was
 * stored.
 * @param ctx - plugin context, for the home path.
 * @returns the store's read/write face.
 */
function createSessionModes(ctx) {
	let path = null;
	let loaded = false;
	let modes = {};
	function storePath() {
		if (path === null) path = sessionStorePath(ctx);
		return path;
	}
	function persist() {
		const target = storePath();
		const temporary = `${target}.${process.pid}.tmp`;
		try {
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(temporary, `${JSON.stringify({ version: SESSION_STORE_VERSION, sessions: modes }, null, 2)}\n`, "utf8");
			renameSync(temporary, target);
			return true;
		} catch (err) {
			console.error("[dsh-confirm-mode] writing the session store failed:", err);
			try {
				unlinkSync(temporary);
			} catch {
				// The temporary file may never have been created; nothing to clean up.
			}
			return false;
		}
	}
	function load() {
		if (loaded) return;
		loaded = true;
		const target = storePath();
		let text = null;
		try {
			text = readFileSync(target, "utf8");
		} catch (err) {
			if (err === null || typeof err !== "object" || err.code !== "ENOENT") {
				console.error("[dsh-confirm-mode] reading the session store failed:", err);
				return;
			}
		}
		if (text !== null) {
			const parsed = parseSessionStore(text);
			if (parsed === null) {
				console.error(`[dsh-confirm-mode] session store is not a mode map, starting empty: ${target}`);
				return;
			}
			modes = parsed;
		}
	}
	return {
		/** One session's own mode, or undefined when it follows the default. */
		get(sessionId) {
			load();
			return typeof sessionId === "string" ? modes[sessionId] : undefined;
		},
		/** A detached copy of the whole map (for snapshots and the route). */
		entries() {
			load();
			return { ...modes };
		},
		/** Forget one session's own mode so it follows the default again. */
		clear(sessionId) {
			load();
			if (!Object.hasOwn(modes, sessionId)) return true;
			delete modes[sessionId];
			return persist();
		},
		/** Store one session's mode; false when it could not be persisted. */
		set(sessionId, mode) {
			load();
			if (modes[sessionId] === mode) return true;
			const previous = modes[sessionId];
			modes[sessionId] = mode;
			if (persist()) return true;
			if (previous === undefined) delete modes[sessionId];
			else modes[sessionId] = previous;
			return false;
		}
	};
}

/**
 * Model-facing sentence for one mode, following the DSH UI language.
 * @param mode - the mode value.
 * @param en - whether the DSH UI language is English.
 * @returns a sentence the injected notice carries.
 */
function modeSentence(mode, en) {
	if (en) {
		switch (mode) {
			case ON: return "confirm mode: every sensitive-permission invocation asks you to approve it, one call at a time; nothing is auto-approved";
			default: return "default: the harness's own permission and approval behaviour applies";
		}
	}
	switch (mode) {
		case ON: return "确认模式：每次调用敏感权限都会要求你逐条确认，不再自动审批";
		default: return "默认：由 DSH 自身的权限与审批策略决定";
	}
}

/**
 * Keep one live agent's approval policy at `ask`, but ONLY when it is not
 * `ask` already: `setPolicy` appends one durable `approval/policy` event per
 * call, so correcting on every gated call would flood the session log.
 *
 * `ask` is the only policy under which an answerer is consulted at all: under
 * `never` (the Full Access preset) `ApprovalService` resolves every request to
 * `rejected` BEFORE any answerer runs, which would silently deny
 * sensitive-permission invocations instead of asking — the exact opposite of
 * this mode.
 *
 * Consumed opportunistically: a host that composes no approval seam keeps the
 * `tools/pre-execute` gate's own degrade-to-deny behavior.
 * @param ctx - plugin context.
 * @param agent - the live agent whose policy should ask.
 * @param sessionId - the agent's session id, when known.
 */
function ensureApprovalAsk(ctx, agent, sessionId) {
	const approval = typeof ctx.get === "function" ? ctx.get("approval") : undefined;
	if (approval === undefined || approval === null || typeof approval.setPolicy !== "function") return;
	const current = effectiveApprovalPolicy(ctx, sessionId);
	if (current === ASK_POLICY) return;
	try {
		approval.setPolicy(agent, ASK_POLICY);
		console.log(`[dsh-confirm-mode] approval policy corrected to ask${sessionId ? ` @ ${sessionId}` : ""} (was ${current ?? "unknown"})`);
	} catch (err) {
		console.error("[dsh-confirm-mode] switching the approval policy failed:", err);
	}
}

/**
 * Persist a new default mode into the profile patch through the config
 * editor, so the settings form and this route edit the SAME value.
 *
 * `configEditor.edit(entry, change)` hands the change a `current` mapping of
 * the row's own patch values; returning the next mapping writes it. A host
 * without the editor (or a row it does not know about) answers `false`, and
 * the route then reports that the default must be set in Settings instead.
 * @param ctx - plugin context.
 * @param mode - the new default mode.
 * @returns true when the write was persisted.
 */
async function writeDefault(ctx, mode) {
	const editor = typeof ctx.get === "function" ? ctx.get("configEditor") : undefined;
	if (editor === undefined || editor === null || typeof editor.edit !== "function" || typeof editor.entries !== "function") return false;
	let entry = null;
	try {
		for (const candidate of editor.entries()) {
			if (candidate !== null && typeof candidate === "object" && candidate.options?.id === name) {
				entry = candidate;
				break;
			}
		}
	} catch {
		return false;
	}
	if (entry === null) return false;
	try {
		await editor.edit(entry, (current) => ({ ...(current ?? {}), [DEFAULT_MODE_FIELD]: mode }));
		return true;
	} catch (err) {
		console.error("[dsh-confirm-mode] writing the default mode failed:", err);
		return false;
	}
}

export function apply(ctx, config) {
	const initial = config !== null && typeof config === "object" ? config : {};

	/**
	 * The live default (DSH 0.1.7+). A `.volatile()` field arrives as a
	 * reference with `get()`; an ordinary value means the harness has no such
	 * projection and the plain config value is the source instead.
	 */
	const liveDefault = initial[DEFAULT_MODE_FIELD] !== null && typeof initial[DEFAULT_MODE_FIELD] === "object" && typeof initial[DEFAULT_MODE_FIELD].get === "function"
		? initial[DEFAULT_MODE_FIELD]
		: null;
	/** A config value that arrived as plain data (no volatile projection). */
	const declaredDefault = MODES.includes(initial[DEFAULT_MODE_FIELD]) ? initial[DEFAULT_MODE_FIELD] : undefined;

	/** The per-session mode map; created before anything can read it. */
	const sessionModes = createSessionModes(ctx);

	/**
	 * The default mode in force: the live config reference first, then a plain
	 * config value, then the fail-closed default.
	 */
	function readDefault() {
		if (liveDefault !== null) {
			const value = liveDefault.get();
			return MODES.includes(value) ? value : DEFAULT_MODE;
		}
		return declaredDefault ?? DEFAULT_MODE;
	}

	/**
	 * The always-sensitive tool names in force: the live config reference
	 * first, then a plain config value, then none.
	 * @returns a Set of lower-cased tool names whose every call is sensitive.
	 */
	function readSensitiveTools() {
		const value = initial[SENSITIVE_TOOLS_FIELD];
		const list = value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
		if (!Array.isArray(list)) return new Set();
		const out = new Set();
		for (const item of list) if (typeof item === "string" && item.length > 0) out.add(item.toLowerCase());
		return out;
	}

	/** One snapshot of both stored values. */
	function snapshot() {
		return { defaultMode: readDefault(), sessions: sessionModes.entries() };
	}

	/**
	 * The default this half last acted on or observed, so a change is announced
	 * exactly once no matter which path reported it: this plugin's own write,
	 * or the loader's `loader/volatile-update` (the settings form's write).
	 */
	let observedDefault = readDefault();

	/**
	 * Resolve one session's effective mode: its own entry, else the default.
	 * @param value - a mode document ({ defaultMode, sessions }).
	 * @param sessionId - the session's id, when known.
	 * @returns one of {@link MODES}.
	 */
	function sessionModeOf(value, sessionId) {
		const stored = typeof sessionId === "string" ? value?.sessions?.[sessionId] : undefined;
		return MODES.includes(stored) ? stored : value?.defaultMode ?? DEFAULT_MODE;
	}

	/**
	 * Notify every agent whose EFFECTIVE mode moved between two snapshots. A
	 * default change reaches only the sessions that follow the default; a
	 * per-session change reaches that session alone.
	 */
	function notify(before, after) {
		const agents = ctx.get("agents");
		if (!agents || typeof agents.list !== "function") return;
		const en = prefersEnglish(ctx);
		for (const agent of agents.list()) {
			try {
				if (!agent || typeof agent.inject !== "function") continue;
				const sessionId = sessionIdOf(agent);
				const mode = sessionModeOf(after, sessionId);
				if (mode === sessionModeOf(before, sessionId)) continue;
				// A message carrying a stable identity (id), frozen before
				// publication, and a producer-owned source kind — see MESSAGE_SOURCE.
				agent.inject(createUserMessage({
					content: [{ type: "text", text: en
						? `The confirm mode of this session was switched by the user to "${modeSentence(mode, true)}".`
						: `本会话的确认模式已由用户切换为「${modeSentence(mode, false)}」。` }],
					source: MESSAGE_SOURCE
				}));
			} catch (err) {
				console.error("[dsh-confirm-mode] agent notify error:", err);
			}
		}
	}

	// One line at mount: it is what tells a user (and a bug report) that the
	// plugin composed on their DSH build at all, and which default is in force.
	console.log(`[dsh-confirm-mode] loaded: default mode = ${observedDefault}`);

	/**
	 * The sensitive-permission gate, registered at the FRONT of the
	 * `tools/pre-execute` waterfall. When the requesting session's mode is ON,
	 * a tool execution that invokes a sensitive permission — it requests an
	 * elevated `sandbox_permissions`, or it names a tool the deployment marked
	 * always-sensitive — is routed through the approval seam with
	 * `{ kind: "ask" }`: the harness then asks the composed answerers, and
	 * `allowed-once` is the only grant, good for exactly one call. Everything
	 * else falls through to DSH's own policy with `next()`.
	 *
	 * One ask, not two: a request STRICTLY wider than the session's effective
	 * sandbox mode will produce its own escalation approval, and the
	 * approval-request answerer below guarantees that one reaches the user —
	 * so this gate stands down for it. A request the session already covers
	 * (Full Access) would produce no ask at all, and that silent case is the
	 * gate's to take.
	 *
	 * The mode is the REQUESTING session's, so one window may confirm while
	 * another keeps the harness default.
	 */
	ctx.on("tools/pre-execute", async (exec, next) => {
		try {
			const sessionId = sessionIdOf(exec?.agent);
			if (sessionModeOf(snapshot(), sessionId) !== ON) return next();
			const tool = exec && exec.name ? exec.name : "(unknown tool)";
			const args = exec?.arguments;
			// An execution that requests a wider sandbox mode through its own
			// `sandbox_permissions` argument is invoking a sensitive permission.
			const wantsPermissions = requestsSandboxPermissions(args);
			// A tool the deployment itself marked always-sensitive.
			const namedSensitive = readSensitiveTools().has(String(tool).toLowerCase());
			if (!wantsPermissions && !namedSensitive) return next();
			// The approval seam must ASK, not silently reject: under the `never`
			// policy ApprovalService resolves before any answerer runs. Corrected
			// only when it is not `ask` already, so the log gains one event per
			// correction rather than one per call.
			ensureApprovalAsk(ctx, exec?.agent, sessionId);
			// Stand down when the tool's own escalation will ask anyway.
			if (wantsPermissions && !namedSensitive) {
				const requested = requestedSandboxMode(args);
				const effective = effectiveSandboxMode(ctx, sessionId);
				if (requested !== null && effective !== null
					&& SANDBOX_RANK[requested] !== undefined && SANDBOX_RANK[effective] !== undefined
					&& SANDBOX_RANK[requested] > SANDBOX_RANK[effective]) {
					return next();
				}
			}
			const what = wantsPermissions
				? `escalating its sandbox permission${typeof args?.sandbox_permissions === "string" ? ` to ${args.sandbox_permissions}` : ""}`
				: "a tool the deployment marks sensitive";
			const reason = `confirm mode: ${tool} invokes ${what}; the user must approve this one call`;
			const displayReason = `确认模式：「${tool}」调用了敏感权限（${what}），需要你逐条确认`;
			console.log(`[dsh-confirm-mode] ask: ${tool}${sessionId ? ` @ ${sessionId}` : ""} (${what})`);
			return { kind: "ask", reason, displayReason };
		} catch (err) {
			console.error("[dsh-confirm-mode] pre-execute gate error:", err);
		}
		return next();
	}, true);

	/**
	 * Front-of-chain approval answerer (prepend). Its only job under confirm
	 * mode is to make sure an approval request is NEVER settled here: every
	 * sensitive-permission ask — a sandbox escalation above all — is handed to
	 * the next answerer, which in the Web GUI is the click-to-approve composer
	 * the user confirms.
	 *
	 * The mode is the REQUESTING session's: a session whose mode is OFF keeps
	 * DSH's own approval behaviour, whatever preset that session runs under.
	 */
	ctx.on("approval/request", async (req, next) => {
		try {
			const sessionId = sessionIdOf(req?.agent);
			if (sessionModeOf(snapshot(), sessionId) !== ON) return next();
			// Under confirm mode the policy must be `ask` (the gate above or the
			// activation corrected it); say so when it is not, because that means
			// a preset switch re-applied `never` behind this plugin's back.
			if (effectiveApprovalPolicy(ctx, sessionId) === NEVER_POLICY) {
				ensureApprovalAsk(ctx, req?.agent, sessionId);
			}
			const tool = req && req.toolName ? req.toolName : "(unknown tool)";
			const at = sessionId ? ` @ ${sessionId}` : "";
			// Logged, never settled: the one-shot widening that lets work leave
			// the workspace is always the user's call, never auto-approved, and
			// never denied here either.
			console.log(`[dsh-confirm-mode] ${isEscalationRequest(req) ? "escalation" : "approval"} ask handed to the user: ${tool}${at}`);
		} catch (err) {
			console.error("[dsh-confirm-mode] answerer error:", err);
		}
		return next();
	}, true);

	/**
	 * Each new agent inherits the mode of its session — including a session
	 * whose default is ON because the plugin's configuration says so. Its
	 * approval policy is corrected once here, so a fresh session under Full
	 * Access asks from its very first sensitive call instead of being silently
	 * denied by a `never` policy the preset applied.
	 */
	ctx.on("agent/created", (payload) => {
		try {
			const agent = payload?.agent ?? payload;
			const sessionId = sessionIdOf(agent);
			if (sessionModeOf(snapshot(), sessionId) !== ON) return;
			ensureApprovalAsk(ctx, agent, sessionId);
		} catch (err) {
			console.error("[dsh-confirm-mode] agent/created error:", err);
		}
	});

	/**
	 * The default may also move without this plugin writing it: on 0.1.7+ the
	 * settings page edits the profile patch and the loader commits the new
	 * value into the live reference this half holds. Observed rather than
	 * polled.
	 */
	ctx.on("loader/volatile-update", (paths) => {
		if (!Array.isArray(paths)) return;
		if (!paths.some((path) => Array.isArray(path) && (path[0] === DEFAULT_MODE_FIELD || path[0] === SENSITIVE_TOOLS_FIELD))) return;
		const current = readDefault();
		const previous = observedDefault;
		observedDefault = current;
		if (previous === current) return;
		const sessions = sessionModes.entries();
		notify({ defaultMode: previous, sessions }, { defaultMode: current, sessions });
	});

	/**
	 * Control route. The ADDRESS says what is read or written — the default, or
	 * one session's own mode — and the body carries only the value:
	 *
	 * GET /confirm-mode -> the default mode
	 * GET /confirm-mode?session= -> that session's effective mode
	 * POST /confirm-mode { mode } -> set the default (profile patch)
	 * POST /confirm-mode?session= { mode } -> set that session's mode
	 *
	 * Loopback-only (same trust posture as the /api fence).
	 */
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ROUTE_PATH,
		handler: async (req, res) => {
			const writeJson = (status, body) => {
				const text = JSON.stringify(body);
				res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
				res.end(text);
			};
			if (!isLoopbackRequest(req)) {
				writeJson(403, { ok: false, error: "forbidden" });
				return;
			}
			let session = null;
			try {
				const addressed = new URL(req.url ?? ROUTE_PATH, "http://localhost").searchParams.get("session");
				// An absent or empty parameter addresses the default; anything else
				// must be an address this route can actually key an entry with.
				if (addressed !== null && addressed.length > 0) {
					if (!isSessionAddress(addressed)) {
						writeJson(400, { ok: false, error: "invalid-session" });
						return;
					}
					session = addressed;
				}
			} catch {
				session = null;
			}
			if (req.method === "GET") {
				const value = snapshot();
				writeJson(200, {
					ok: true,
					mode: session === null ? value.defaultMode : sessionModeOf(value, session),
					defaultMode: value.defaultMode,
					...session === null ? {} : { session }
				});
				return;
			}
			if (req.method !== "POST") {
				writeJson(405, { ok: false, error: "method-not-allowed" });
				return;
			}
			let parsed;
			try {
				const body = await readBody(req);
				parsed = body.length === 0 ? {} : JSON.parse(body);
			} catch {
				writeJson(400, { ok: false, error: "bad-json" });
				return;
			}
			const mode = parsed !== null && typeof parsed === "object" ? parsed.mode : undefined;
			// `mode: null` clears a session's own choice so it follows the default again.
			const clearing = parsed !== null && typeof parsed === "object" && parsed.mode === null && session !== null;
			if (!MODES.includes(mode) && !clearing) {
				writeJson(400, { ok: false, error: "invalid-mode", mode });
				return;
			}
			const before = snapshot();
			if (session !== null) {
				if (clearing) {
					if (!sessionModes.clear(session)) {
						writeJson(500, { ok: false, error: "store-write-failed" });
						return;
					}
				} else if (!sessionModes.set(session, mode)) {
					writeJson(500, { ok: false, error: "store-write-failed" });
					return;
				}
				const after = snapshot();
				notify(before, after);
				// Correct the live agent's approval policy when the mode moved to
				// ON: the gate can correct it too, but doing it here means the very
				// first sensitive call asks instead of being denied.
				if (sessionModeOf(after, session) === ON) {
					for (const agent of (ctx.get("agents")?.list?.() ?? [])) {
						if (sessionIdOf(agent) === session) ensureApprovalAsk(ctx, agent, session);
					}
				}
				writeJson(200, {
					ok: true,
					mode: sessionModeOf(after, session),
					defaultMode: after.defaultMode,
					changed: sessionModeOf(before, session) !== sessionModeOf(after, session),
					session
				});
				return;
			}
			if (before.defaultMode === mode) {
				writeJson(200, { ok: true, mode, defaultMode: mode, changed: false });
				return;
			}
			// Claim the new value BEFORE the host reports its own write back
			// through the loader event observed above, so the change is
			// announced exactly once.
			const announced = observedDefault;
			observedDefault = mode;
			const stored = await writeDefault(ctx, mode);
			if (!stored) {
				observedDefault = announced;
				writeJson(409, {
					ok: false,
					error: "default-not-writable",
					mode: before.defaultMode,
					hint: "Set the default mode in Settings → Plugins → dsh-confirm-mode."
				});
				return;
			}
			const after = snapshot();
			notify(before, after);
			writeJson(200, { ok: true, mode, defaultMode: after.defaultMode, changed: true });
		}
	}), "dsh-confirm-mode: control route");
}
