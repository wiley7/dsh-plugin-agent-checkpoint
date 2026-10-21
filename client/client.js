/**
 * dsh-plugin-agent-checkpoint — browser half.
 *
 * Hand-written `__ModuleLoader__` bundle (no build step): registers one entry in
 * the `conversation.chat.assistant-actions` list slot, i.e. the action strip
 * under every finalized assistant message, and renders the git commit the
 * workspace is currently on — `⎇ main 4e850e7`, with `•` for uncommitted
 * changes and `⚑` when the commit is a confirmed checkpoint. Clicking copies the
 * full hash; the tooltip carries the subject, the commit time and the
 * checkpoint id.
 *
 * The browser cannot read a repository, so the numbers come from this plugin's
 * own loopback route (`/api/agent-checkpoint/git`, served by the host half)
 * through a same-origin fetch keyed by the viewed session id — the host half
 * resolves that session's `cwd` from the DSH session log.
 *
 * The endpoint is polled at a deliberately boring cadence (20 s while mounted,
 * paused while the tab is hidden) and memoized per session, so a long
 * conversation with dozens of replies costs one small request, not one per
 * message. All display decisions are pure functions on the snapshot so they can
 * be exercised from Node without a DOM.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-agent-checkpoint",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		//#region pure core
		/** Route served by the host half (`src/host.ts`). */
		const ENDPOINT = "/api/agent-checkpoint/git";
		/** Newest commits the badge asks for; the head only needs the first row. */
		const COMMIT_LIMIT = 50;
		/** Background refresh cadence while the conversation is on screen. */
		const REFRESH_MS = 20000;
		/** A snapshot younger than this is reused instead of refetched on mount. */
		const CACHE_TTL_MS = 8000;

		/**
		 * Request URL for one viewed session.
		 * @param sessionId - session whose log header names the workspace.
		 * @returns same-origin URL with the session and window encoded.
		 */
		function badgeUrl(sessionId) {
			const params = new URLSearchParams({ session: String(sessionId), limit: String(COMMIT_LIMIT) });
			return `${ENDPOINT}?${params.toString()}`;
		}

		/**
		 * Reject structurally unusable payloads from a fetch that may hit proxies.
		 * @param raw - parsed JSON body.
		 * @returns the snapshot, or null when it cannot be displayed.
		 */
		function normalizeSnapshot(raw) {
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
			if (raw.ok !== true || raw.isRepo !== true) return null;
			if (raw.head === null || typeof raw.head !== "object") return null;
			if (typeof raw.head.hash !== "string" || raw.head.hash === "") return null;
			return raw;
		}

		/**
		 * Fold one snapshot into the strings the badge renders.
		 * @param snapshot - normalized snapshot, or null before the first fetch.
		 * @returns display model, or null when there is nothing to show.
		 */
		function describeCommit(snapshot) {
			const normalized = normalizeSnapshot(snapshot);
			if (normalized === null) return null;
			const head = normalized.head;
			const short = typeof head.short === "string" && head.short !== "" ? head.short : head.hash.slice(0, 7);
			const branch = typeof normalized.branch === "string" && normalized.branch !== "" ? normalized.branch : null;
			const checkpoint = head.checkpoint !== null && typeof head.checkpoint === "object" && typeof head.checkpoint.id === "string" ? head.checkpoint : null;
			const titleParts = [];
			if (branch !== null) titleParts.push(branch);
			if (typeof head.subject === "string" && head.subject !== "") titleParts.push(head.subject);
			titleParts.push(head.hash);
			if (typeof head.committedAt === "string" && head.committedAt !== "") titleParts.push(head.committedAt);
			if (checkpoint !== null) titleParts.push(`checkpoint: ${checkpoint.id}${typeof checkpoint.title === "string" && checkpoint.title !== "" ? ` — ${checkpoint.title}` : ""}`);
			if (normalized.isDirty === true) titleParts.push("workspace has uncommitted changes");
			titleParts.push(`workspace: ${normalized.workspace}`);
			return {
				hash: head.hash,
				short,
				branch,
				dirty: normalized.isDirty === true,
				checkpoint,
				title: titleParts.join("\n"),
				label: `${short}${normalized.isDirty === true ? "*" : ""}`,
			};
		}
		//#endregion

		//#region snapshot store
		/**
		 * One memoized, shareable snapshot per viewed session.
		 *
		 * Modules are materialized once per browser tab, so every rendered badge
		 * (one per finalized message) subscribes to the same record and the same
		 * in-flight request — a conversation with forty replies still polls once.
		 * @returns store facade over a private per-session map.
		 */
		function createStore() {
			/** @type {Map<string, { snapshot: object | null, at: number, inFlight: Promise<void> | null, listeners: Set<Function>, error: string | null }>} */
			const records = new Map();

			function recordOf(sessionId) {
				const key = String(sessionId);
				let record = records.get(key);
				if (record === undefined) {
					record = { snapshot: null, at: 0, inFlight: null, listeners: new Set(), error: null };
					records.set(key, record);
				}
				return record;
			}

			function publish(record) {
				for (const listener of [...record.listeners]) {
					try {
						listener(record.snapshot);
					} catch (error) {
						console.error("dsh-plugin-agent-checkpoint: badge listener failed", error);
					}
				}
			}

			function refresh(sessionId, force = false) {
				const record = recordOf(sessionId);
				if (record.inFlight !== null) return record.inFlight;
				const fresh = record.snapshot !== null && Date.now() - record.at < CACHE_TTL_MS;
				if (fresh && !force) return Promise.resolve();
				const request = fetch(badgeUrl(sessionId), {
					headers: { accept: "application/json" },
					credentials: "same-origin",
					cache: "no-store",
				})
					.then((response) => {
						if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
						return response.json();
					})
					.then((body) => {
						// A non-repository workspace is remembered as "nothing to show" so a
						// plain folder does not scroll the error into the console every poll.
						record.snapshot = body !== null && typeof body === "object" && body.isRepo === false ? null : body;
						record.at = Date.now();
						record.error = typeof body === "object" && body !== null && typeof body.error === "string" ? body.error : null;
						publish(record);
					})
					.catch((error) => {
						record.error = error instanceof Error ? error.message : String(error);
						record.at = 0;
					})
					.finally(() => {
						record.inFlight = null;
					});
				record.inFlight = request;
				return request;
			}

			return {
				peek(sessionId) {
					return recordOf(sessionId).snapshot;
				},
				error(sessionId) {
					return recordOf(sessionId).error;
				},
				refresh,
				subscribe(sessionId, listener) {
					const record = recordOf(sessionId);
					record.listeners.add(listener);
					// Push the current value so a late subscriber renders without waiting
					// for the next poll to land.
					if (record.snapshot !== null) listener(record.snapshot);
					void refresh(sessionId);
					return () => {
						record.listeners.delete(listener);
					};
				},
			};
		}

		const store = createStore();
		//#endregion

		//#region dictionaries
		/** Locale namespace owned by this plugin. */
		const NS = "agent-checkpoint";
		const en = {
			"commit.aria": "Git commit of the workspace: {{short}}. Click to copy the full hash.",
			"commit.dirty": "uncommitted changes",
			"commit.checkpoint": "confirmed checkpoint",
			"commit.copied": "Commit hash copied",
			"commit.unavailable": "Workspace is not a git repository",
		};
		const zh = {
			"commit.aria": "工作区当前提交：{{short}}，点击复制完整哈希",
			"commit.dirty": "有未提交改动",
			"commit.checkpoint": "已确认的检查点",
			"commit.copied": "已复制提交哈希",
			"commit.unavailable": "工作区不是 git 仓库",
		};
		//#endregion

		//#region styles
		/**
		 * The action row sizes its children as icon buttons, so the badge is a
		 * quiet inline pill: monospace, secondary color, no background of its own.
		 */
		const BUTTON_STYLE = {
			display: "inline-flex",
			alignItems: "center",
			gap: "4px",
			padding: "0 6px",
			height: "20px",
			border: "1px solid transparent",
			borderRadius: "6px",
			background: "transparent",
			color: "inherit",
			opacity: "0.72",
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: "11px",
			lineHeight: "20px",
			cursor: "pointer",
			whiteSpace: "nowrap",
		};
		const HASH_STYLE = { fontWeight: "600" };
		const MUTED_STYLE = { opacity: "0.7" };
		const DIRTY_STYLE = { color: "#d97706", fontWeight: "700" };
		const FLAG_STYLE = { color: "#0ea5e9" };
		//#endregion

		//#region component
		/**
		 * Hook over the shared store: current snapshot for one session plus the
		 * mount/unmount polling lifecycle.
		 * @param sessionId - viewed session, supplied by the slot's inject face.
		 * @returns latest snapshot or null.
		 */
		function useCommitSnapshot(sessionId) {
			const [ snapshot, setSnapshot ] = React.useState(() => (sessionId ? store.peek(sessionId) : null));
			React.useEffect(() => {
				if (!sessionId) return undefined;
				const unsubscribe = store.subscribe(sessionId, setSnapshot);
				const timer = setInterval(() => {
					// A hidden tab keeps its last value: nothing consumes the badge and
					// the repository is unlikely to move while nobody is looking.
					if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
					void store.refresh(sessionId, true);
				}, REFRESH_MS);
				return () => {
					unsubscribe();
					clearInterval(timer);
				};
			}, [ sessionId ]);
			return snapshot;
		}

		/**
		 * One badge: branch, short hash, dirty marker, checkpoint flag.
		 * @param props - slot owner props plus the inject face (`sessionId`).
		 * @returns the badge element, or null when there is nothing to show.
		 */
		function CommitBadge(props) {
			const sessionId = props.sessionId;
			const t = props.t;
			const snapshot = useCommitSnapshot(sessionId);
			const [ copied, setCopied ] = React.useState(false);
			const model = describeCommit(snapshot);
			if (!sessionId || model === null) return null;

			const text = (key, fallback) => {
				try {
					const translated = typeof t === "function" ? t(key, { short: model.short }) : undefined;
					return typeof translated === "string" && translated !== "" ? translated : fallback;
				} catch {
					return fallback;
				}
			};

			const copy = () => {
				const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
				if (clipboard === undefined || typeof clipboard.writeText !== "function") return;
				clipboard.writeText(model.hash).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1200);
				}, () => {});
			};

			const children = [];
			if (model.branch !== null) children.push(React.createElement("span", { key: "branch", style: MUTED_STYLE }, `${model.branch} `));
			children.push(React.createElement("span", { key: "hash", style: HASH_STYLE }, model.short));
			if (model.dirty) children.push(React.createElement("span", { key: "dirty", style: DIRTY_STYLE }, "*"));
			if (model.checkpoint !== null) children.push(React.createElement("span", { key: "checkpoint", style: FLAG_STYLE, title: text("commit.checkpoint", "confirmed checkpoint") }, "⚑"));

			return React.createElement(
				"button",
				{
					type: "button",
					style: BUTTON_STYLE,
					className: "dsh-agent-checkpoint-commit",
					"data-agent-checkpoint-commit": model.short,
					title: copied ? text("commit.copied", "Commit hash copied") : model.title,
					"aria-label": text("commit.aria", `Git commit ${model.short}. Click to copy the full hash.`),
					onClick: copy,
				},
				children,
			);
		}
		//#endregion

		//#region plugin
		/** The slot registry and the copy service are the only dependencies. */
		const inject = [ "slots", "locale" ];

		/**
		 * Register the badge under every finalized assistant message.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { en, zh }), "agent-checkpoint: dictionaries");
			ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
				name: "conversation.chat.assistant-actions",
				id: "agent-checkpoint-commit",
				order: 60,
				locale: NS,
				inject: (sessionId) => ({ sessionId }),
			}, CommitBadge));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.CommitBadge = CommitBadge;
		exports.describeCommit = describeCommit;
		exports.normalizeSnapshot = normalizeSnapshot;
		exports.badgeUrl = badgeUrl;
		exports.createStore = createStore;
		return module.exports;
	}
});
