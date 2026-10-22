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
 * When that project is not a git repository yet there is nothing to show, so the
 * same seat renders an "enable checkpoints" control instead: one click arms it,
 * the second click posts to `/api/agent-checkpoint/init` (guarded by
 * `confirm=1`), the host half creates the repository, the ignore rules and the
 * `.dsh-checkpoint/` store, and the badge turns into the commit pill.
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
		/** Route that turns the viewed project into a checkpoint workspace. */
		const INIT_ENDPOINT = "/api/agent-checkpoint/init";
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
		/**
		 * Request URL that initialises the viewed project as a checkpoint
		 * workspace. `confirm=1` is what the operator's second click grants; the
		 * host half refuses the write without it.
		 * @param sessionId - session whose log header names the workspace.
		 * @returns same-origin URL for the POST.
		 */
		function initUrl(sessionId) {
			const params = new URLSearchParams({ session: String(sessionId), confirm: "1" });
			return `${INIT_ENDPOINT}?${params.toString()}`;
		}

		/**
		 * Decide what the badge seat renders for one fetched payload.
		 *
		 * Showing an "enable checkpoints" control is a write offer, so it is only
		 * made when the workspace came from the *conversation*: a fallback cwd
		 * (DSH's own launch directory) is not the user's project and must never
		 * sprout an init button.
		 * @param raw - parsed JSON body of the badge route, or null.
		 * @returns a commit model, an init offer, or nothing to render.
		 */
		function describeWorkspace(raw) {
			const model = describeCommit(raw);
			if (model !== null) return { kind: "commit", model, snapshot: normalizeSnapshot(raw) };
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { kind: "none" };
			if (raw.ok === false && raw.error === "not_a_git_repo" && raw.source === "session" && typeof raw.workspace === "string" && raw.workspace !== "") {
				return { kind: "init", workspace: raw.workspace };
			}
			return { kind: "none" };
		}

		/**
		 * Pick the attribution entry the host computed for one assistant message.
		 *
		 * Each reply is attributed to the checkpoint that was current *when it was
		 * written*, so an old reply keeps naming the old snapshot instead of
		 * silently claiming the newest commit.
		 * @param snapshot - normalized snapshot, or null before the first fetch.
		 * @param messageId - id the chat slot hands to this seat.
		 * @returns the matching entry, or null when the host knows no such message.
		 */
		function attributeMessage(snapshot, messageId) {
			const normalized = normalizeSnapshot(snapshot);
			if (normalized === null) return null;
			if (typeof messageId !== "string" || messageId === "") return null;
			const list = Array.isArray(normalized.attribution) ? normalized.attribution : [];
			for (const entry of list) {
				if (entry === null || typeof entry !== "object") continue;
				if (entry.messageId !== messageId) continue;
				return entry;
			}
			return null;
		}

		/**
		 * Fold one message's attribution into the strings the badge renders.
		 * @param snapshot - normalized snapshot, or null.
		 * @param messageId - id of the reply this seat belongs to.
		 * @returns display model, or null when this reply has no checkpoint.
		 */
		function describeMessageCheckpoint(snapshot, messageId) {
			const entry = attributeMessage(snapshot, messageId);
			if (entry === null) return null;
			const checkpointId = typeof entry.checkpointId === "string" && entry.checkpointId !== "" ? entry.checkpointId : null;
			// A reply written before the first snapshot keeps an empty seat: showing
			// the newest commit here is exactly the bug this seat exists to avoid.
			if (checkpointId === null) return null;
			const status = entry.status === "confirmed" ? "confirmed" : "draft";
			const short = typeof entry.short === "string" && entry.short !== "" ? entry.short : checkpointId.slice(-8);
			const hash = typeof entry.commitHash === "string" && entry.commitHash !== "" ? entry.commitHash : checkpointId;
			const titleParts = [ `checkpoint: ${checkpointId}`, status === "confirmed" ? "confirmed snapshot" : "draft snapshot, not committed yet" ];
			if (typeof entry.title === "string" && entry.title !== "") titleParts.push(entry.title);
			if (typeof entry.commitHash === "string" && entry.commitHash !== "") titleParts.push(`commit ${entry.commitHash}`);
			if (typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)) titleParts.push(new Date(entry.createdAt).toISOString());
			if (typeof entry.fromTurn === "number" && Number.isFinite(entry.fromTurn)) titleParts.push(`saved in turn ${entry.fromTurn}`);
			if (entry.inherited === true) titleParts.push("saved before this reply and still current");
			return {
				checkpointId,
				short,
				status,
				hash,
				title: titleParts.join("\n"),
				label: `${status === "confirmed" ? "⚑" : "✎"} ${short}`,
			};
		}

		/**
		 * Whether the host half computed per-message attribution.
		 *
		 * A host from before this field existed answers without `attribution`; the
		 * badge then keeps its old workspace-head behaviour instead of vanishing.
		 * @param snapshot - normalized snapshot, or null.
		 * @returns true when the payload carries an attribution array.
		 */
		function supportsAttribution(snapshot) {
			const normalized = normalizeSnapshot(snapshot);
			return normalized !== null && Array.isArray(normalized.attribution);
		}

		/**
		 * The commit that was HEAD at one instant, taken from the fetched window.
		 * @param commits - newest-first commit timeline of the snapshot.
		 * @param at - epoch milliseconds of an assistant message.
		 * @returns the newest commit committed at or before `at`, or null.
		 */
		function commitAt(commits, at) {
			if (!Array.isArray(commits) || !Number.isFinite(at)) return null;
			let best = null;
			let bestAt = -Infinity;
			for (const commit of commits) {
				if (commit === null || typeof commit !== "object") continue;
				const ms = typeof commit.committedAtMs === "number" && Number.isFinite(commit.committedAtMs)
					? commit.committedAtMs
					: Date.parse(typeof commit.committedAt === "string" ? commit.committedAt : "");
				if (!Number.isFinite(ms) || ms > at) continue;
				if (ms > bestAt) {
					best = commit;
					bestAt = ms;
				}
			}
			return best;
		}

		/**
		 * What to show under one reply: its checkpoint when it has one, otherwise
		 * the commit that was HEAD at that moment.
		 *
		 * The second case keeps the badge alive in projects that never adopted
		 * checkpoints, and either way the value is the one from *that* reply's time
		 * — never today's HEAD.
		 * @param snapshot - normalized snapshot, or null.
		 * @param messageId - id of the reply this seat belongs to.
		 * @returns display model, or null when the reply predates every commit.
		 */
		function describeMessageBadge(snapshot, messageId) {
			const entry = attributeMessage(snapshot, messageId);
			if (entry === null) return null;
			const checkpoint = describeMessageCheckpoint(snapshot, messageId);
			if (checkpoint !== null) return { ...checkpoint, kind: "checkpoint" };
			const normalized = normalizeSnapshot(snapshot);
			const commit = normalized === null ? null : commitAt(normalized.commits, entry.at);
			if (commit === null || typeof commit.hash !== "string" || commit.hash === "") return null;
			const short = typeof commit.short === "string" && commit.short !== "" ? commit.short : commit.hash.slice(0, 7);
			const titleParts = [ `commit: ${commit.hash}` ];
			if (typeof commit.subject === "string" && commit.subject !== "") titleParts.push(commit.subject);
			if (typeof commit.committedAt === "string" && commit.committedAt !== "") titleParts.push(commit.committedAt);
			titleParts.push("no checkpoint at this point in the conversation");
			return { kind: "commit", checkpointId: null, short, status: "commit", hash: commit.hash, title: titleParts.join("\n"), label: short };
		}
		//#endregion

		//#region policy core
		/** Settings namespace shared with the host half (`src/config.ts`). */
		const POLICY_NAMESPACE = "agent-checkpoint";
		/** Values the `trigger` field accepts, in display order. */
		const TRIGGER_IDS = [ "off", "file_change", "turn", "interval_turns" ];
		/** Values the `apply` field accepts, in display order. */
		const APPLY_IDS = [ "draft", "commit" ];
		/** Documented defaults: rendering must never let an unknown value through. */
		const POLICY_DEFAULTS = { trigger: "off", apply: "draft", interval_turns: 5 };
		/** Lower bound of the interval spinner (`interval_turns`). */
		const INTERVAL_MIN = 1;
		/** Upper bound of the interval spinner (`interval_turns`). */
		const INTERVAL_MAX = 50;

		/**
		 * Coerce one interval value into an integer inside 1..50.
		 * @param raw - number or numeric string from the settings store / input.
		 * @returns the clamped integer, or null when the value is not numeric.
		 */
		function clampIntervalTurns(raw) {
			const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
			if (!Number.isFinite(number)) return null;
			const rounded = Math.round(number);
			if (rounded < INTERVAL_MIN) return INTERVAL_MIN;
			if (rounded > INTERVAL_MAX) return INTERVAL_MAX;
			return rounded;
		}

		/**
		 * Normalize a persisted settings value onto the documented contract.
		 *
		 * Unknown, absent or wrong-typed fields fall back to {@link POLICY_DEFAULTS},
		 * so a render never has to deal with `undefined` and a stale value written
		 * by a newer build cannot blank the card.
		 * @param raw - `value` of the settings scope snapshot, or a flat state.
		 * @returns the normalized `{ trigger, apply, interval_turns }` value.
		 */
		function normalizePolicyValue(raw) {
			const value = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
			const trigger = TRIGGER_IDS.indexOf(value.trigger) >= 0 ? value.trigger : POLICY_DEFAULTS.trigger;
			const apply = APPLY_IDS.indexOf(value.apply) >= 0 ? value.apply : POLICY_DEFAULTS.apply;
			const interval = clampIntervalTurns(value.interval_turns);
			return {
				trigger,
				apply,
				interval_turns: interval === null ? POLICY_DEFAULTS.interval_turns : interval,
			};
		}

		/**
		 * Materialize one rendered policy state.
		 *
		 * Accepts either a bound settings snapshot (`{ status, value, writable }`,
		 * the shape `settingsScope.bind()` hands out) or this module's own flat
		 * store state (which already spells the fields out).
		 * @param raw - bound snapshot or flat state, possibly null before mount.
		 * @returns `{ status, writable, trigger, apply, interval_turns }`.
		 */
		function policyStateOf(raw) {
			const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
			const status = source !== null && (source.status === "ready" || source.status === "unavailable") ? source.status : "loading";
			const normalized = normalizePolicyValue(source !== null && source.value !== undefined ? source.value : source);
			return {
				status,
				writable: source !== null && source.writable === true,
				trigger: normalized.trigger,
				apply: normalized.apply,
				interval_turns: normalized.interval_turns,
			};
		}

		/**
		 * Whether two rendered policy states are equal field by field.
		 * @param a - first state.
		 * @param b - second state.
		 * @returns true when publishing `b` would be a no-op.
		 */
		function samePolicyState(a, b) {
			return a.status === b.status && a.writable === b.writable && a.trigger === b.trigger && a.apply === b.apply && a.interval_turns === b.interval_turns;
		}

		/**
		 * The store the card subscribes to and every write goes through.
		 *
		 * `attach` adopts the settings scope bound to {@link POLICY_NAMESPACE}:
		 * it reads the host snapshot once and re-syncs on every change. `set`
		 * updates the local state first — the card must react to its own click
		 * before the write round-trips — then persists through the bound scope, so
		 * there is no staging and no save button.
		 * @returns store facade for `hooks.checkpointPolicy` and the card.
		 */
		function createPolicyStore() {
			let state = policyStateOf(null);
			let scope = null;
			const listeners = new Set();

			function publish(next) {
				if (samePolicyState(state, next)) return;
				state = next;
				for (const listener of [ ...listeners ]) {
					try {
						listener();
					} catch (error) {
						console.error("dsh-plugin-agent-checkpoint: policy listener failed", error);
					}
				}
			}

			function nextValueOf(field, value) {
				if (field === "trigger") return TRIGGER_IDS.indexOf(value) >= 0 ? value : null;
				if (field === "apply") return APPLY_IDS.indexOf(value) >= 0 ? value : null;
				if (field === "interval_turns") return clampIntervalTurns(value);
				return null;
			}

			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				getSnapshot() {
					return state;
				},
				attach(bound) {
					scope = bound;
					const sync = () => {
						const snapshot = bound !== null && typeof bound === "object" && typeof bound.getSnapshot === "function" ? bound.getSnapshot() : null;
						publish(policyStateOf(snapshot));
					};
					sync();
					return bound !== null && typeof bound === "object" && typeof bound.subscribe === "function" ? bound.subscribe(sync) : () => {};
				},
				set(field, value) {
					const next = nextValueOf(field, value);
					// Values outside the contract are dropped here rather than stored:
					// a stale card must never write a value the host cannot interpret.
					if (next === null) return;
					const patch = {};
					patch[field] = next;
					publish({ ...state, ...patch });
					if (scope === null || typeof scope.set !== "function") return;
					try {
						scope.set(field, next);
					} catch (error) {
						console.error("dsh-plugin-agent-checkpoint: settings write failed", error);
					}
				},
			};
		}

		/** Shared policy store: one per browser tab, like the badge snapshot store. */
		const policyStore = createPolicyStore();
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
			/** @type {Map<string, { snapshot: object | null, body: object | null, at: number, inFlight: Promise<void> | null, listeners: Set<Function>, error: string | null }>} */
			const records = new Map();

			function recordOf(sessionId) {
				const key = String(sessionId);
				let record = records.get(key);
				if (record === undefined) {
					record = { snapshot: null, body: null, at: 0, inFlight: null, listeners: new Set(), error: null };
					records.set(key, record);
				}
				return record;
			}

			function publish(record) {
				for (const listener of [...record.listeners]) {
					try {
						// The raw body travels with the snapshot: the badge needs
						// `error`/`source` to decide whether to offer initialisation.
						listener(record.snapshot, record.body);
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
						record.body = body !== null && typeof body === "object" ? body : null;
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

			/**
			 * Enable checkpoints for the viewed project.
			 *
			 * Sends the operator-confirmed POST, then republishes: a successful
			 * initialisation turns the same seat from the init control into the
			 * commit pill without a page reload.
			 * @param sessionId - viewed session, naming the project to initialise.
			 * @returns the route's parsed body.
			 * @throws when the route answers non-2xx or with `ok:false`.
			 */
			function initialize(sessionId) {
				const record = recordOf(sessionId);
				return fetch(initUrl(sessionId), {
					method: "POST",
					headers: { accept: "application/json" },
					credentials: "same-origin",
					cache: "no-store",
				})
					.then((response) => response.json().catch(() => null).then((body) => ({ response, body })))
					.then(({ response, body }) => {
						if (!response.ok || body === null || typeof body !== "object" || body.ok !== true) {
							const message = body !== null && typeof body === "object" && typeof body.message === "string" ? body.message : `HTTP ${String(response.status)}`;
							record.error = message;
							record.at = 0;
							throw new Error(message);
						}
						record.error = null;
						record.at = 0;
						return refresh(sessionId, true).then(() => body);
					});
			}

			return {
				peek(sessionId) {
					return recordOf(sessionId).snapshot;
				},
				body(sessionId) {
					return recordOf(sessionId).body;
				},
				error(sessionId) {
					return recordOf(sessionId).error;
				},
				refresh,
				initialize,
				subscribe(sessionId, listener) {
					const record = recordOf(sessionId);
					record.listeners.add(listener);
					// Push the current value so a late subscriber renders without waiting
					// for the next poll to land.
					if (record.snapshot !== null || record.body !== null) listener(record.snapshot, record.body);
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
			"commit.draft": "draft checkpoint, not committed yet",
			"commit.message.aria": "Checkpoint saved with this reply: {{short}}. Click to copy the full hash.",
			"commit.copied": "Commit hash copied",
			"commit.unavailable": "Workspace is not a git repository",
			"init.label": "Enable checkpoints",
			"init.aria": "Set up git checkpoints for {{workspace}}",
			"init.confirm": "Confirm setup",
			"init.cancel": "Cancel",
			"init.running": "Enabling checkpoints…",
			"init.failed": "Setup failed — click to retry",
			"policy.name": "Automatic checkpoints",
			"policy.desc": "Choose when the assistant saves your progress by itself. Saves are drafts by default — nothing is committed until you say so.",
			"policy.trigger.off.label": "Off",
			"policy.trigger.off.hint": "Nothing is created automatically. Ask the assistant to save when you want a checkpoint.",
			"policy.trigger.file_change.label": "Whenever files change",
			"policy.trigger.file_change.hint": "A backup is created after any round that changed files. Quiet rounds are skipped.",
			"policy.trigger.turn.label": "After every message",
			"policy.trigger.turn.hint": "A backup is created after every round, including the conversation when no file changed.",
			"policy.trigger.interval.label": "Every few messages",
			"policy.trigger.interval.hint": "A backup is created every N rounds, for example every 5.",
			"policy.interval.label": "Number of rounds",
			"policy.interval.unit": "rounds",
			"policy.apply.label": "When saving",
			"policy.apply.draft.label": "Keep as draft",
			"policy.apply.draft.hint": "Safe default: drafts stay outside git history until you confirm one.",
			"policy.apply.commit.label": "Commit right away",
			"policy.apply.commit.hint": "Each save becomes a real git commit. The badge under the reply shows it.",
			"policy.note.draft": "Drafts are stored in .dsh-checkpoint and never enter git history on their own.",
			"policy.note.commit": "Every save writes a git commit in this project, so git history grows with your conversation.",
			"policy.loading": "Reading settings…",
			"policy.unavailable": "This DSH build does not expose settings, so automatic checkpoints are unavailable.",
			"policy.readonly": "These settings are locked by the host configuration.",
			"policy.saved": "Saved",
		};
		const zh = {
			"commit.aria": "工作区当前提交：{{short}}，点击复制完整哈希",
			"commit.dirty": "有未提交改动",
			"commit.checkpoint": "已确认的检查点",
			"commit.draft": "草稿检查点，尚未提交",
			"commit.message.aria": "这条回复保存的检查点：{{short}}，点击复制完整哈希",
			"commit.copied": "已复制提交哈希",
			"commit.unavailable": "工作区不是 git 仓库",
			"init.label": "启用检查点",
			"init.aria": "为 {{workspace}} 启用 git 检查点",
			"init.confirm": "确认启用",
			"init.cancel": "取消",
			"init.running": "正在启用检查点…",
			"init.failed": "启用失败，点击重试",
			"policy.name": "自动检查点",
			"policy.desc": "选什么时候让助手自动帮你保存进度。默认只存草稿，不确认就不会提交到 git。",
			"policy.trigger.off.label": "关闭",
			"policy.trigger.off.hint": "不自动创建。需要时说一句「保存一下」即可。",
			"policy.trigger.file_change.label": "改了文件就保存",
			"policy.trigger.file_change.hint": "这一轮改动过文件就自动存一份；没改文件就跳过。",
			"policy.trigger.turn.label": "每次对话都保存",
			"policy.trigger.turn.hint": "每轮对话结束都存一份，即使没改文件也会连对话一起存。",
			"policy.trigger.interval.label": "每隔几次对话保存",
			"policy.trigger.interval.hint": "每 N 轮存一次，比如填 5 就是每 5 轮保存。",
			"policy.interval.label": "间隔轮数",
			"policy.interval.unit": "轮",
			"policy.apply.label": "保存方式",
			"policy.apply.draft.label": "只存草稿",
			"policy.apply.draft.hint": "最安全：草稿不进 git 历史，等你确认后才变成提交。",
			"policy.apply.commit.label": "直接提交",
			"policy.apply.commit.hint": "每次保存都写成真实 git 提交，回复下方的徽章会显示它。",
			"policy.note.draft": "草稿保存在 .dsh-checkpoint 里，不会自己进 git 历史。",
			"policy.note.commit": "每次保存都会在这个项目里写一条 git 提交，历史会跟着对话增长。",
			"policy.loading": "正在读取设置…",
			"policy.unavailable": "这个 DSH 版本没有提供设置服务，自动检查点暂不可用。",
			"policy.readonly": "这些设置被宿主配置锁定，暂时不能修改。",
			"policy.saved": "已保存",
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
		/** Draft snapshots exist only in .dsh-checkpoint, so they read quieter. */
		const DRAFT_STYLE = { color: "#8b8f96" };
		/**
		 * The init control only appears on projects without a repository, so it is
		 * the quietest thing in the row: dashed hairline, secondary color.
		 */
		const INIT_BUTTON_STYLE = {
			...BUTTON_STYLE,
			border: "1px dashed currentColor",
			opacity: "0.6",
			fontFamily: "inherit",
		};
		/** Armed state: the operator asked once, the write still needs one more click. */
		const CONFIRM_STYLE = {
			...BUTTON_STYLE,
			border: "1px solid #d97706",
			color: "#b45309",
			opacity: "1",
			fontWeight: "600",
			fontFamily: "inherit",
		};
		const CANCEL_STYLE = { ...BUTTON_STYLE, opacity: "0.55", padding: "0 4px", fontFamily: "inherit" };
		const INIT_ROW_STYLE = { display: "inline-flex", alignItems: "center", gap: "4px" };
		const RUNNING_STYLE = {
			display: "inline-flex",
			alignItems: "center",
			padding: "0 6px",
			height: "20px",
			fontSize: "11px",
			lineHeight: "20px",
			opacity: "0.6",
			whiteSpace: "nowrap",
		};
		//#endregion

		//#region component
		/**
		 * Hook over the shared store: current snapshot for one session plus the
		 * mount/unmount polling lifecycle.
		 * @param sessionId - viewed session, supplied by the slot's inject face.
		 * @returns latest snapshot and the raw response body.
		 */
		function useWorkspace(sessionId) {
			const [ state, setState ] = React.useState(() => ({
				snapshot: sessionId ? store.peek(sessionId) : null,
				body: sessionId ? store.body(sessionId) : null,
			}));
			React.useEffect(() => {
				if (!sessionId) return undefined;
				const unsubscribe = store.subscribe(sessionId, (snapshot, body) => setState({ snapshot, body }));
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
			return state;
		}

		/**
		 * One seat under the reply row: the commit pill, or — for a project that is
		 * not a repository yet — the two-step "enable checkpoints" control.
		 * @param props - slot owner props plus the inject face (`sessionId`).
		 * @returns the element, or null when there is nothing to show.
		 */
		function CommitBadge(props) {
			const sessionId = props.sessionId;
			const t = props.t;
			const state = useWorkspace(sessionId);
			const [ copied, setCopied ] = React.useState(false);
			const [ initState, setInitState ] = React.useState("idle");
			const [ initError, setInitError ] = React.useState(null);

			const text = (key, fallback, params) => {
				try {
					const translated = typeof t === "function" ? t(key, params) : undefined;
					return typeof translated === "string" && translated !== "" ? translated : fallback;
				} catch {
					return fallback;
				}
			};

			if (!sessionId) return null;
			const view = describeWorkspace(state.body ?? state.snapshot);
			if (view.kind === "none") return null;

			if (view.kind === "init") {
				const workspace = view.workspace;
				const label = text("init.aria", "Set up git checkpoints", { workspace });
				const run = () => {
					setInitError(null);
					setInitState("running");
					store.initialize(sessionId).then(
						() => setInitState("idle"),
						(error) => {
							setInitError(error instanceof Error ? error.message : String(error));
							setInitState("error");
						},
					);
				};
				if (initState === "running") {
					return React.createElement("span", { key: "init", style: RUNNING_STYLE, className: "dsh-agent-checkpoint-init" }, text("init.running", "Enabling checkpoints…"));
				}
				if (initState === "error") {
					return React.createElement(
						"button",
						{
							key: "init",
							type: "button",
							style: INIT_BUTTON_STYLE,
							className: "dsh-agent-checkpoint-init is-error",
							title: initError ?? "",
							"aria-label": text("init.failed", "Setup failed — click to retry"),
							onClick: () => setInitState("idle"),
						},
						text("init.failed", "Setup failed — click to retry"),
					);
				}
				if (initState === "confirm") {
					return React.createElement(
						"span",
						{ key: "init", style: INIT_ROW_STYLE, className: "dsh-agent-checkpoint-init is-confirming" },
						React.createElement(
							"button",
							{
								type: "button",
								style: CONFIRM_STYLE,
								title: `${label}\n${workspace}`,
								"aria-label": label,
								onClick: run,
							},
							text("init.confirm", "Confirm setup"),
						),
						React.createElement(
							"button",
							{
								type: "button",
								style: CANCEL_STYLE,
								title: text("init.cancel", "Cancel"),
								"aria-label": text("init.cancel", "Cancel"),
								onClick: () => setInitState("idle"),
							},
							"✕",
						),
					);
				}
				return React.createElement(
					"button",
					{
						key: "init",
						type: "button",
						style: INIT_BUTTON_STYLE,
						className: "dsh-agent-checkpoint-init",
						title: `${label}\n${workspace}`,
						"aria-label": label,
						"data-agent-checkpoint-init": workspace,
						onClick: () => setInitState("confirm"),
					},
					`⚙ ${text("init.label", "Enable checkpoints")}`,
				);
			}

			// Which checkpoint belongs to *this* reply. Older hosts that do not pass a
			// message id fall back to the workspace head so the badge keeps working.
			const messageId = typeof props.messageId === "string" && props.messageId !== "" ? props.messageId : null;
			const canAttribute = messageId !== null && supportsAttribution(view.snapshot);
			const attributed = canAttribute ? describeMessageBadge(view.snapshot, messageId) : null;
			if (canAttribute && attributed === null) return null;
			const model = attributed !== null
				? { short: attributed.short, hash: attributed.hash, title: attributed.title, status: attributed.status === "commit" ? null : attributed.status, label: attributed.label }
				: { short: view.model.short, hash: view.model.hash, title: view.model.title, status: view.model.checkpoint !== null ? "confirmed" : null, label: view.model.label };

			const copy = () => {
				const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
				if (clipboard === undefined || typeof clipboard.writeText !== "function") return;
				clipboard.writeText(model.hash).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1200);
				}, () => {});
			};

			const children = [];
			if (model.status !== null) {
				children.push(React.createElement("span", { key: "status", style: model.status === "confirmed" ? FLAG_STYLE : DRAFT_STYLE, title: text(model.status === "confirmed" ? "commit.checkpoint" : "commit.draft", model.status === "confirmed" ? "confirmed checkpoint" : "draft checkpoint") }, model.status === "confirmed" ? "⚑" : "✎"));
			}
			if (attributed === null && view.model.branch !== null) children.push(React.createElement("span", { key: "branch", style: MUTED_STYLE }, `${view.model.branch} `));
			children.push(React.createElement("span", { key: "hash", style: HASH_STYLE }, model.short));
			if (attributed === null && view.model.dirty) children.push(React.createElement("span", { key: "dirty", style: DIRTY_STYLE }, "*"));

			return React.createElement(
				"button",
				{
					type: "button",
					style: BUTTON_STYLE,
					className: "dsh-agent-checkpoint-commit",
					"data-agent-checkpoint-commit": model.short,
					"data-agent-checkpoint-status": model.status ?? "head",
					title: copied ? text("commit.copied", "Hash copied") : model.title,
					"aria-label": text("commit.message.aria", `Checkpoint saved with this reply: ${model.short}. Click to copy.`, { short: model.short }),
					onClick: copy,
				},
				children,
			);
		}
		//#endregion

		//#region settings card
		/** Row styles: dense, plain, and readable at settings-page scale. */
		const CARD_ROW_STYLE = {
			display: "flex",
			alignItems: "flex-start",
			gap: "8px",
			padding: "6px 0",
			cursor: "pointer",
			border: "0",
			background: "transparent",
			color: "inherit",
			textAlign: "left",
			width: "100%",
			font: "inherit",
		};
		const DOT_STYLE = {
			flex: "0 0 auto",
			width: "14px",
			height: "14px",
			marginTop: "3px",
			borderRadius: "50%",
			border: "1.5px solid currentColor",
			boxSizing: "border-box",
			opacity: "0.55",
		};
		const DOT_ON_STYLE = { ...DOT_STYLE, border: "4px solid currentColor", opacity: "0.9" };
		const ROW_TEXT_STYLE = { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" };
		const ROW_LABEL_STYLE = { fontSize: "13px", lineHeight: "18px" };
		const ROW_HINT_STYLE = { fontSize: "11.5px", lineHeight: "16px", opacity: "0.62" };
		const CARD_NOTE_STYLE = { fontSize: "11.5px", lineHeight: "16px", opacity: "0.62", margin: "6px 0 0" };
		const NUMBER_STYLE = {
			width: "56px",
			marginLeft: "6px",
			padding: "1px 4px",
			borderRadius: "4px",
			border: "1px solid currentColor",
			background: "transparent",
			color: "inherit",
			font: "inherit",
			fontSize: "12px",
		};

		/**
		 * One radio row: a labelled choice plus a plain-language explanation.
		 * @param key - stable React key.
		 * @param label - what the choice does, in one phrase.
		 * @param hint - why someone would pick it.
		 * @param active - selected flag.
		 * @param disabled - locked by the host.
		 * @param onSelect - click handler.
		 * @returns the row element.
		 */
		function choiceRow(key, label, hint, active, disabled, onSelect) {
			return React.createElement(
				"button",
				{
					key,
					type: "button",
					role: "radio",
					"aria-checked": active ? "true" : "false",
					"aria-label": label,
					style: { ...CARD_ROW_STYLE, cursor: disabled ? "default" : "pointer", opacity: disabled ? "0.5" : "1" },
					className: "dsh-agent-checkpoint-choice",
					"data-agent-checkpoint-choice": key,
					"data-active": active ? "true" : "false",
					disabled,
					onClick: onSelect,
				},
				React.createElement("span", { style: active ? DOT_ON_STYLE : DOT_STYLE }),
				React.createElement(
					"span",
					{ style: ROW_TEXT_STYLE },
					React.createElement("span", { style: ROW_LABEL_STYLE }, label),
					React.createElement("span", { style: ROW_HINT_STYLE }, hint),
				),
			);
		}

		/**
		 * Settings card: when should DSH save a checkpoint by itself.
		 *
		 * The wording is operational ("whenever files change", "after every
		 * message") rather than architectural, because the reader is deciding how
		 * their project gets backed up, not how the plugin is built. Writes are
		 * immediate — there is no save button, matching the host's live scope.
		 * @param props - `useCheckpointPolicy` hook plus the locale function `t`.
		 * @returns the card element mounted in the settings page.
		 */
		function PolicyCard(props) {
			const t = props.t;
			const state = typeof props.useCheckpointPolicy === "function" ? props.useCheckpointPolicy() : policyStateOf(null);
			const text = (key, fallback) => {
				try {
					const translated = typeof t === "function" ? t(key) : undefined;
					return typeof translated === "string" && translated !== "" ? translated : fallback;
				} catch {
					return fallback;
				}
			};
			const disabled = state.status !== "ready" || state.writable !== true;
			const set = (field, value) => {
				if (disabled) return;
				policyStore.set(field, value);
			};

			const triggerRows = TRIGGER_IDS.map((id) =>
				choiceRow(
					id,
					text(`policy.trigger.${id}.label`, id),
					text(`policy.trigger.${id}.hint`, ""),
					state.trigger === id,
					disabled,
					() => set("trigger", id),
				),
			);

			// The interval field stays visible so the number is easy to find after
			// switching modes; it is only editable in its own mode.
			const intervalRow = React.createElement(
				"div",
				{ key: "interval", style: { ...CARD_ROW_STYLE, cursor: "default", paddingLeft: "22px" } },
				React.createElement("span", { style: ROW_LABEL_STYLE }, text("policy.interval.label", "Number of rounds")),
				React.createElement("input", {
					type: "number",
					min: String(INTERVAL_MIN),
					max: String(INTERVAL_MAX),
					step: "1",
					value: String(state.interval_turns),
					style: { ...NUMBER_STYLE, opacity: disabled || state.trigger !== "interval_turns" ? "0.45" : "0.9" },
					disabled: disabled || state.trigger !== "interval_turns",
					"aria-label": text("policy.interval.label", "Number of rounds"),
					"data-agent-checkpoint-interval": String(state.interval_turns),
					onChange: (event) => set("interval_turns", event.target.value),
				}),
			);

			const applyRows = APPLY_IDS.map((id) =>
				choiceRow(
					`apply-${id}`,
					text(`policy.apply.${id}.label`, id),
					text(`policy.apply.${id}.hint`, ""),
					state.apply === id,
					disabled,
					() => set("apply", id),
				),
			);

			const note = state.status === "unavailable"
				? text("policy.unavailable", "Settings are unavailable, so automatic checkpoints are off.")
				: state.status !== "ready"
					? text("policy.loading", "Reading settings…")
					: state.writable !== true
						? text("policy.readonly", "These settings are locked by the host configuration.")
						: text(state.apply === "commit" ? "policy.note.commit" : "policy.note.draft", "");

			return React.createElement(
				"li",
				{ className: "lc-settings-card", "data-agent-checkpoint-card": POLICY_NAMESPACE },
				React.createElement(
					"div",
					{ className: "lc-settings-head" },
					React.createElement(
						"div",
						{ className: "lc-settings-headtext" },
						React.createElement("div", { className: "lc-settings-name" }, text("policy.name", "Automatic checkpoints")),
						React.createElement("div", { className: "lc-settings-desc" }, text("policy.desc", "")),
					),
				),
				React.createElement(
					"div",
					{ className: "lc-settings-body" },
					React.createElement(
						"div",
						{ role: "radiogroup", "aria-label": text("policy.name", "Automatic checkpoints") },
						triggerRows,
						intervalRow,
					),
					React.createElement(
						"div",
						{ role: "radiogroup", "aria-label": text("policy.apply.label", "When saving"), style: { marginTop: "10px" } },
						React.createElement("div", { style: { ...ROW_LABEL_STYLE, opacity: "0.75" } }, text("policy.apply.label", "When saving")),
						applyRows,
					),
				),
				React.createElement("p", { className: "lc-settings-note", style: CARD_NOTE_STYLE }, note),
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

			// The card is only rendered when the host also serves the namespace,
			// so a DSH build without the settings service simply shows no card.
			if (typeof ctx.inject !== "function") return;
			ctx.inject([ "settingsScope" ], (scoped) => {
				const bound = scoped.settingsScope.bind({ namespace: POLICY_NAMESPACE });
				scoped.effect(() => policyStore.attach(bound), "agent-checkpoint: settings scope");
				scoped.slots.inject("settings.plugin.item", () => scoped.slots.register({
					name: "settings.plugin.item",
					key: POLICY_NAMESPACE,
					locale: NS,
					inject: () => ({ hooks: { checkpointPolicy: policyStore } }),
				}, PolicyCard));
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.CommitBadge = CommitBadge;
		exports.describeCommit = describeCommit;
		exports.describeWorkspace = describeWorkspace;
		exports.attributeMessage = attributeMessage;
		exports.describeMessageCheckpoint = describeMessageCheckpoint;
		exports.describeMessageBadge = describeMessageBadge;
		exports.supportsAttribution = supportsAttribution;
		exports.commitAt = commitAt;
		exports.normalizeSnapshot = normalizeSnapshot;
		exports.badgeUrl = badgeUrl;
		exports.initUrl = initUrl;
		exports.createStore = createStore;
		exports.PolicyCard = PolicyCard;
		exports.createPolicyStore = createPolicyStore;
		exports.policyStateOf = policyStateOf;
		exports.clampIntervalTurns = clampIntervalTurns;
		exports.normalizePolicyValue = normalizePolicyValue;
		return module.exports;
	}
});
