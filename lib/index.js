/**
 * Token 用量看板 —— Host 半边。
 *
 * 数据落在 `~/.dsh/token-usage/usage.db`（Node 24 内置 `node:sqlite`，无三方依赖），
 * 浏览器通过插件自己注册的 HTTP 路由 `POST /__token-usage` 读取。
 *
 * 三条写入来源，共用同一套「事件 → 行」逻辑（lib/core.js）：
 *   1. 实时：`ctx.on("session/event", …)`，DSH 持久化用的就是这条 seam；
 *   2. 回填：`ctx.sessionQuery.listSessions()` + `readSession()`，读历史日志；
 *   3. 汇率：每天一次后台拉取，写进 settings。
 *
 * 成本在**写入时**算好并冻结：之后改价、改汇率、改节假日都不会回头重算历史。
 * 未定价的模型成本为 NULL（不是 0），面板显示 `—`。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
	buildAttemptRow,
	buildUsageRow,
	dayKey,
	matchPricing,
	normalizeModelId,
	normalizePeakValley,
	normalizeTiers,
	parsePricingFile,
	resolveModelId
} from "./core.js";

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(homedir(), ".dsh", "token-usage");
const DB_PATH = join(DATA_DIR, "usage.db");
const ROUTE_PATH = "/__token-usage";
const CLIENT_HEADER = "x-token-usage-client";
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_FX = 7.1;
const FX_ENDPOINTS = [
	{ name: "open.er-api.com", url: "https://open.er-api.com/v6/latest/USD", pick: (body) => body?.rates?.CNY },
	{ name: "api.frankfurter.dev", url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY", pick: (body) => body?.rates?.CNY }
];
const HOLIDAY_ENDPOINTS = [
	(year) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
	(year) => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`
];
const USAGE_TYPES = new Set(["assistant/message", "assistant/attempt"]);

/** 一条事件的稳定指纹：父子会话复制历史时 type/time/data 完全一致，seq 也一致。 */
function fingerprint(event) {
	return createHash("sha1").update(event.type + "|" + event.time + "|" + JSON.stringify(event.data)).digest("base64");
}

/** 读 JSON 文件；失败返回 null（调用方决定是降级还是报错）。 */
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

//#region 数据库

/** 打开数据库并建表。WAL 让读写不互相阻塞；schema 变更全部走 IF NOT EXISTS，可重复执行。 */
function openDatabase() {
	mkdirSync(DATA_DIR, { recursive: true });
	const db = new DatabaseSync(DB_PATH);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec(`
		CREATE TABLE IF NOT EXISTS usage_requests (
			session_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			ts INTEGER NOT NULL,
			day TEXT NOT NULL,
			provider TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL DEFAULT '',
			input_tokens INTEGER NOT NULL DEFAULT 0,
			cache_read_tokens INTEGER NOT NULL DEFAULT 0,
			cache_write_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			total_tokens INTEGER NOT NULL DEFAULT 0,
			ttft_ms INTEGER,
			decode_ms INTEGER,
			speed REAL,
			peak INTEGER NOT NULL DEFAULT 1,
			cost REAL,
			cost_currency TEXT,
			cost_cny REAL,
			cost_usd REAL,
			rate_used REAL,
			PRIMARY KEY (session_id, seq)
		)
	`);
	db.exec("CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_requests (day)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_requests (ts)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_requests (provider, model)");
	db.exec(`
		CREATE TABLE IF NOT EXISTS attempt_failures (
			session_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			ts INTEGER NOT NULL,
			day TEXT NOT NULL,
			kind TEXT NOT NULL,
			code TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (session_id, seq)
		)
	`);
	db.exec("CREATE INDEX IF NOT EXISTS idx_failures_day ON attempt_failures (day)");
	db.exec(`
		CREATE TABLE IF NOT EXISTS model_pricing (
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			currency TEXT NOT NULL,
			unit TEXT NOT NULL,
			input_price REAL NOT NULL,
			cache_read_price REAL NOT NULL,
			cache_write_price REAL NOT NULL,
			output_price REAL NOT NULL,
			off_peak_prices TEXT,
			peak_valley TEXT NOT NULL,
			tiers TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (provider, model)
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS calendar_days (
			date TEXT PRIMARY KEY,
			year INTEGER NOT NULL,
			name TEXT NOT NULL DEFAULT '',
			off INTEGER NOT NULL,
			source TEXT NOT NULL DEFAULT 'official'
		)
	`);
	// 老库补列：长上下文档位是后加的，CREATE TABLE IF NOT EXISTS 不会给已有表加列。
	const pricingColumns = db.prepare("PRAGMA table_info(model_pricing)").all().map((row) => row.name);
	if (!pricingColumns.includes("tiers")) db.exec("ALTER TABLE model_pricing ADD COLUMN tiers TEXT");
	db.exec(`
		CREATE TABLE IF NOT EXISTS model_aliases (
			alias TEXT PRIMARY KEY,
			canonical TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);
	db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	return db;
}

/** settings 的读写包装（值一律按字符串存，读时按需转换）。 */
function createSettings(db) {
	const read = db.prepare("SELECT value FROM settings WHERE key = ?");
	const write = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
	return {
		get(key, fallback) {
			const row = read.get(key);
			return row === undefined ? fallback : row.value;
		},
		set(key, value) {
			write.run(key, String(value));
		}
	};
}

/** meta 表：一次性标记（价格是否已播种、回填是否完成）。 */
function createMeta(db) {
	const read = db.prepare("SELECT value FROM meta WHERE key = ?");
	const write = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
	return {
		get(key) {
			return read.get(key)?.value;
		},
		set(key, value) {
			write.run(key, String(value));
		}
	};
}

//#endregion

//#region 价格

/** JSON 列解析：坏数据当作没有，不要让整张价格表塌掉。 */
function parseJsonOrNull(text) {
	if (text === null || text === undefined) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** 数据库行 → core 使用的价格对象。 */
function toPricing(row) {
	let peakValley;
	try {
		peakValley = normalizePeakValley(JSON.parse(row.peak_valley));
	} catch {
		peakValley = normalizePeakValley(null);
	}
	return {
		provider: row.provider,
		model: row.model,
		currency: row.currency,
		unit: row.unit,
		prices: {
			input: row.input_price,
			cacheRead: row.cache_read_price,
			cacheWrite: row.cache_write_price,
			output: row.output_price
		},
		offPeakPrices: parseJsonOrNull(row.off_peak_prices),
		tiers: normalizeTiers(parseJsonOrNull(row.tiers) ?? []),
		peakValley
	};
}

/** 价格表快照：每次改价后重建，读取路径不再查库。 */
function createPricingStore(db) {
	const selectAll = db.prepare("SELECT * FROM model_pricing ORDER BY provider, model");
	const upsert = db.prepare(`
		INSERT INTO model_pricing
			(provider, model, currency, unit, input_price, cache_read_price, cache_write_price, output_price, off_peak_prices, peak_valley, tiers, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(provider, model) DO UPDATE SET
			currency = excluded.currency, unit = excluded.unit,
			input_price = excluded.input_price, cache_read_price = excluded.cache_read_price,
			cache_write_price = excluded.cache_write_price, output_price = excluded.output_price,
			off_peak_prices = excluded.off_peak_prices, peak_valley = excluded.peak_valley,
			tiers = excluded.tiers, updated_at = excluded.updated_at
	`);
	let cache = [];
	const reload = () => {
		cache = selectAll.all().map(toPricing);
	};
	reload();
	const write = (entry) => {
		upsert.run(
			entry.provider,
			entry.model,
			entry.currency,
			entry.unit,
			entry.prices.input,
			entry.prices.cacheRead,
			entry.prices.cacheWrite,
			entry.prices.output,
			entry.offPeakPrices === null ? null : JSON.stringify(entry.offPeakPrices),
			JSON.stringify(entry.peakValley),
			JSON.stringify(entry.tiers ?? []),
			new Date().toISOString()
		);
	};
	return {
		list: () => cache,
		reload,
		/** pricing.json 是唯一权威：整表替换，文件里没有的模型就不再有价格。 */
		replaceAll(entries) {
			db.exec("BEGIN");
			try {
				db.exec("DELETE FROM model_pricing");
				for (const entry of entries) write(entry);
				db.exec("COMMIT");
			} catch (error) {
				try {
					db.exec("ROLLBACK");
				} catch {
					/* 回滚失败时保留原始错误 */
				}
				throw error;
			}
			reload();
		},
		count: () => cache.length
	};
}

/**
 * 模型别名：日志里的写法 → 价格表里的模型名。
 * 价格只来自 pricing.json，别名只回答「这个名字该按哪个模型计价」，两者职责分开。
 */
function createAliasStore(db) {
	const selectAll = db.prepare("SELECT alias, canonical FROM model_aliases ORDER BY alias");
	const upsert = db.prepare(
		"INSERT INTO model_aliases (alias, canonical, updated_at) VALUES (?, ?, ?) ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical, updated_at = excluded.updated_at"
	);
	const removeStmt = db.prepare("DELETE FROM model_aliases WHERE alias = ?");
	let map = new Map();
	const reload = () => {
		map = new Map(selectAll.all().map((row) => [row.alias, row.canonical]));
	};
	reload();
	return {
		map: () => map,
		reload,
		list: () => selectAll.all(),
		save(alias, canonical) {
			upsert.run(alias, canonical, new Date().toISOString());
			reload();
		},
		remove(alias) {
			removeStmt.run(alias);
			reload();
		}
	};
}

/**
 * 价格以 pricing.json 为准：每次启动把文件里的条目**整份写入**数据库，
 * 并删除数据库里文件已经没有的模型。改价只影响之后写入的记录，历史成本不变。
 *
 * 文件缺失或校验失败时**不动数据库**——宁可继续用旧价格，也不能因为一次手误
 * 把所有模型变成「未定价」。
 */
function applyPricingFile(store, meta, logger) {
	const text = readFileSyncSafe(join(PLUGIN_DIR, "pricing.json"));
	if (text === null) return { applied: 0, removed: 0, error: null };
	try {
		const parsed = parsePricingFile(text);
		store.replaceAll(parsed.models);
		meta.set("pricing_seeded", "1");
		return { applied: parsed.models.length, removed: 0, error: null, usdCnyRate: parsed.usdCnyRate };
	} catch (error) {
		return { applied: 0, removed: 0, error: error instanceof Error ? error.message : String(error) };
	}
}

function readFileSyncSafe(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

//#endregion

//#region 节假日日历

/** 内置节假日 → 数据库（ON CONFLICT 不覆盖，手动补录优先）。 */
function seedCalendar(db) {
	const seed = readJson(join(PLUGIN_DIR, "calendar.seed.json"));
	if (seed === null || typeof seed.years !== "object") return;
	const insert = db.prepare("INSERT OR IGNORE INTO calendar_days (date, year, name, off, source) VALUES (?, ?, ?, ?, 'official')");
	for (const [year, days] of Object.entries(seed.years)) {
		if (!Array.isArray(days)) continue;
		for (const day of days) {
			if (typeof day?.date !== "string") continue;
			insert.run(day.date, Number(year), typeof day.name === "string" ? day.name : "", day.off === true ? 1 : 0);
		}
	}
}

/** 日历查询：day → `holiday` / `workday` / `normal`。内存缓存，补录后重建。 */
function createCalendar(db) {
	const selectAll = db.prepare("SELECT date, off FROM calendar_days");
	const countYear = db.prepare("SELECT COUNT(*) AS n FROM calendar_days WHERE year = ?");
	let map = new Map();
	const reload = () => {
		map = new Map(selectAll.all().map((row) => [row.date, row.off === 1 ? "holiday" : "workday"]));
	};
	reload();
	return {
		rule: (day) => map.get(day) ?? "normal",
		reload,
		/** 某年是否已经有数据（用来决定要不要去拉一次）。 */
		hasYear: (year) => Number(countYear.get(year)?.n ?? 0) > 0
	};
}

/**
 * 节假日数据自动维护：内置表打底，缺哪一年就去公开数据源补一次。
 * 没有界面、没有开关——拉不到就继续用已有数据，节假日的归属最多退回「按时钟」。
 */
async function refreshCalendar(db, calendar, logger) {
	const insert = db.prepare(
		"INSERT INTO calendar_days (date, year, name, off, source) VALUES (?, ?, ?, ?, 'official') ON CONFLICT(date) DO UPDATE SET name = excluded.name, off = excluded.off, year = excluded.year"
	);
	const year = new Date().getFullYear();
	for (const target of [year, year + 1]) {
		if (calendar.hasYear(target)) continue;
		const days = await fetchHolidayYear(target);
		if (days === null) continue;
		for (const day of days) insert.run(day.date, target, day.name, day.off ? 1 : 0);
		calendar.reload();
		logger.info("token-usage: 已载入 " + target + " 年节假日 " + days.length + " 条");
	}
}

//#endregion

//#region 汇率

/**
 * 每天拉一次中间价。失败保留上一次的值；从未取到过就用 7.1 兜底并标记 source=default。
 * 汇率只影响之后写入的记录（写入时快照进 rate_used）。
 */
function createFx(settings, logger) {
	let inflight = null;
	const current = () => {
		const rate = Number(settings.get("usd_cny_rate", ""));
		return {
			rate: Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_FX,
			date: settings.get("usd_cny_rate_date", ""),
			source: settings.get("usd_cny_rate_source", "default"),
			provider: settings.get("usd_cny_rate_provider", "")
		};
	};
	const store = (rate, source, provider) => {
		settings.set("usd_cny_rate", rate);
		settings.set("usd_cny_rate_date", dayKey(Date.now()));
		settings.set("usd_cny_rate_source", source);
		settings.set("usd_cny_rate_provider", provider);
		return current();
	};
	const refresh = async () => {
		if (inflight !== null) return inflight;
		inflight = (async () => {
			for (const endpoint of FX_ENDPOINTS) {
				try {
					const response = await fetch(endpoint.url, { signal: AbortSignal.timeout(8000) });
					if (!response.ok) continue;
					const body = await response.json();
					const rate = Number(endpoint.pick(body));
					if (Number.isFinite(rate) && rate > 0) return store(rate, "auto", endpoint.name);
				} catch (error) {
					logger.warn("token-usage: 汇率源 " + endpoint.name + " 失败：" + (error instanceof Error ? error.message : String(error)));
				}
			}
			return null;
		})().finally(() => {
			inflight = null;
		});
		return inflight;
	};
	/** 每天一次：当天已更新过就跳过。 */
	const ensureDaily = async () => {
		const state = current();
		if (state.date === dayKey(Date.now())) return state;
		const refreshed = await refresh();
		return refreshed ?? state;
	};
	return { current, refresh, ensureDaily };
}

//#endregion

//#region 事件折叠

/** 事件 → 数据库行。实时与回填共用，保证口径唯一。 */
function ingestEvents({ sessionId, events, pricing, aliases, calendar, fxRate, skip }) {
	const rows = [];
	const failures = [];
	let stepStart = null;
	for (const event of events) {
		if (skip !== null && USAGE_TYPES.has(event.type) && skip.has(fingerprint(event))) continue;
		if (event.type === "step/start") {
			stepStart = Number(event.time);
			continue;
		}
		if (event.type === "assistant/message") {
			const row = buildUsageRow({
				sessionId,
				event,
				stepStartTime: stepStart,
				pricing: matchPricing(pricing, event.data?.message?.source?.provider, event.data?.message?.source?.model, aliases),
				calendar,
				fxRate
			});
			if (row !== null) rows.push(row);
			continue;
		}
		if (event.type === "assistant/attempt") {
			const row = buildAttemptRow({ sessionId, event });
			if (row !== null) failures.push(row);
		}
	}
	return { rows, failures };
}

//#endregion

//#region HTTP 接口

/**
 * 顶部卡片的范围：7 / 30 / 全部（0）。
 * 返回 null 表示「全部」，调用方据此跳过 day 过滤。
 */
function rangeDays(payload) {
	const requested = Number(payload?.days);
	if (requested === 0) return null;
	if (!Number.isFinite(requested) || requested <= 0) return 30;
	return Math.min(3650, Math.round(requested));
}

/** 时间范围过滤：把 from/to 转成 day 边界。 */
function rangeOf(payload) {
	const from = typeof payload?.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.from) ? payload.from : null;
	const to = typeof payload?.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.to) ? payload.to : null;
	return { from, to };
}

/** 组装 HTTP 层：所有 action 都在这里，前端只做展示。 */
function createApi({ db, settings, meta, pricing, calendar, aliases, fx, logger }) {
	const statements = {
		sum: db.prepare(`
			SELECT COUNT(*) AS requests,
				COALESCE(SUM(input_tokens), 0) AS input,
				COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
				COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
				COALESCE(SUM(output_tokens), 0) AS output,
				COALESCE(SUM(total_tokens), 0) AS total,
				COALESCE(SUM(cost_cny), 0) AS costCny,
				COALESCE(SUM(cost_usd), 0) AS costUsd,
				COALESCE(SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END), 0) AS unpricedRows
			FROM usage_requests
		`),
		sumRange: db.prepare(`
			SELECT COUNT(*) AS requests,
				COALESCE(SUM(input_tokens), 0) AS input,
				COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
				COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
				COALESCE(SUM(output_tokens), 0) AS output,
				COALESCE(SUM(total_tokens), 0) AS total,
				COALESCE(SUM(cost_cny), 0) AS costCny,
				COALESCE(SUM(cost_usd), 0) AS costUsd,
				COALESCE(SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END), 0) AS unpricedRows
			FROM usage_requests WHERE day >= ?
		`),
		failuresSince: db.prepare("SELECT kind, COUNT(*) AS n FROM attempt_failures WHERE day >= ? GROUP BY kind"),
		firstDay: db.prepare("SELECT MIN(day) AS day FROM usage_requests"),
		sumSince: db.prepare(`
			SELECT COUNT(*) AS requests,
				COALESCE(SUM(total_tokens), 0) AS total,
				COALESCE(SUM(cost_cny), 0) AS costCny,
				COALESCE(SUM(cost_usd), 0) AS costUsd
			FROM usage_requests WHERE day = ?
		`),
		failures: db.prepare("SELECT kind, COUNT(*) AS n FROM attempt_failures GROUP BY kind"),
		allModels: db.prepare(`
			SELECT provider, model, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens
			FROM usage_requests GROUP BY provider, model ORDER BY requests DESC
		`),
		byDay: db.prepare(`
			SELECT day, COUNT(*) AS requests,
				COALESCE(SUM(input_tokens), 0) AS input,
				COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
				COALESCE(SUM(output_tokens), 0) AS output,
				COALESCE(SUM(total_tokens), 0) AS total,
				COALESCE(SUM(cost_cny), 0) AS costCny,
				COALESCE(SUM(cost_usd), 0) AS costUsd
			FROM usage_requests WHERE day >= ? GROUP BY day ORDER BY day
		`),
		models: db.prepare(`
			SELECT provider, model, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens, MAX(ts) AS lastTs
			FROM usage_requests GROUP BY provider, model ORDER BY requests DESC
		`)
	};
	const currency = () => (settings.get("display_currency", "CNY") === "USD" ? "USD" : "CNY");
	/**
	 * 币种由浏览器按「当前语言」决定：中文 ¥、其他语言 $。
	 * 客户端每次请求都带上 currency，因此切换语言无需重启，也不会和 Host 设置打架。
	 */
	const pickCurrency = (payload) => (payload?.currency === "USD" || payload?.currency === "CNY" ? payload.currency : currency());
	const costIn = (row, cur) => (cur === "USD" ? Number(row.costUsd) : Number(row.costCny));
	const toTokens = (row) => ({
		requests: Number(row.requests),
		input: Number(row.input),
		cacheRead: Number(row.cacheRead),
		cacheWrite: Number(row.cacheWrite),
		output: Number(row.output),
		total: Number(row.total)
	});

	/**
	 * 按「规范模型」聚合所有 (provider, model)：
	 * `google/gemini-3.8-flash` 与 `gemini-3.8-flash` 合成一条，variants 保留原始写法排查用。
	 * `priced` 用当前价格表实时判断 —— 它回答「现在有没有价格」，而不是「历史上算没算过」。
	 */
	const groups = () => {
		const map = new Map();
		const pricings = pricing.list();
		const aliasMap = aliases.map();
		for (const row of statements.allModels.all()) {
			const canonical = resolveModelId(row.model);
			const entry = map.get(canonical) ?? { model: canonical, requests: 0, tokens: 0, priced: false, variants: [] };
			const requests = Number(row.requests);
			const tokens = Number(row.tokens);
			entry.requests += requests;
			entry.tokens += tokens;
			entry.variants.push({ provider: row.provider, model: row.model, requests, tokens });
			if (matchPricing(pricings, row.provider, row.model, aliasMap) !== null) entry.priced = true;
			map.set(canonical, entry);
		}
		return [...map.values()]
			.sort((a, b) => b.requests - a.requests)
			.map((entry) => ({ ...entry, variants: entry.variants.sort((a, b) => b.requests - a.requests) }));
	};
	const unpricedGroups = () => groups().filter((entry) => !entry.priced);

	return {
		overview(payload) {
			const cur = pickCurrency(payload);
			const days = rangeDays(payload);
			const from = days === null ? null : dayKey(Date.now() - (days - 1) * 86400000);
			const totals = from === null ? statements.sum.get() : statements.sumRange.get(from);
			const today = statements.sumSince.get(dayKey(Date.now()));
			const failures = { error: 0, aborted: 0 };
			const failureRows = from === null ? statements.failures.all() : statements.failuresSince.all(from);
			for (const row of failureRows) failures[row.kind] = Number(row.n);
			const promptTokens = Number(totals.input) + Number(totals.cacheRead);
			return {
				currency: cur,
				totals: { ...toTokens(totals), cost: costIn(totals, cur), costOther: cur === "USD" ? Number(totals.costCny) : Number(totals.costUsd) },
				today: { requests: Number(today.requests), tokens: Number(today.total), cost: costIn(today, cur) },
				hitRate: promptTokens > 0 ? Number(totals.cacheRead) / promptTokens : null,
				unpricedRows: Number(totals.unpricedRows),
				failures,
				unpriced: unpricedGroups(),
				fx: fx.current(),
				pricing: { entries: pricing.count() },
				range: { days: days === null ? 0 : days, from },
				backfill: { done: meta.get("backfill_day") === dayKey(Date.now()), at: meta.get("backfill_at") ?? null },
				pricingError: meta.get("pricing_error") || null
			};
		},
		trend(payload) {
			const cur = pickCurrency(payload);
			const wanted = rangeDays(payload);
			// `0` / 缺省以外传 0 表示「全部」：从第一条记录那天画起，最多回看两年。
			let days;
			if (wanted === null) {
				const first = statements.firstDay.get()?.day;
				const span = first === undefined || first === null ? 1 : Math.floor((Date.now() - Date.parse(first + "T00:00:00+08:00")) / 86400000) + 1;
				days = Math.min(730, Math.max(1, span));
			} else {
				days = wanted;
			}
			const start = new Date(Date.now() - (days - 1) * 86400000);
			const rows = statements.byDay.all(dayKey(start.getTime()));
			const map = new Map(rows.map((row) => [row.day, row]));
			const out = [];
			for (let offset = days - 1; offset >= 0; offset -= 1) {
				const day = dayKey(Date.now() - offset * 86400000);
				const row = map.get(day);
				out.push({
					day,
					requests: row === undefined ? 0 : Number(row.requests),
					input: row === undefined ? 0 : Number(row.input),
					cacheRead: row === undefined ? 0 : Number(row.cacheRead),
					output: row === undefined ? 0 : Number(row.output),
					total: row === undefined ? 0 : Number(row.total),
					cost: row === undefined ? 0 : costIn(row, cur)
				});
			}
			return { days: out };
		},
		heatmap(payload) {
			const cur = pickCurrency(payload);
			const weeks = Math.min(60, Math.max(4, Number(payload?.weeks) || 53));
			const start = Date.now() - (weeks * 7 - 1) * 86400000;
			const rows = statements.byDay.all(dayKey(start));
			return {
				days: rows.map((row) => ({ day: row.day, requests: Number(row.requests), total: Number(row.total), cost: costIn(row, cur) }))
			};
		},
		logs(payload) {
			const page = Math.max(1, Number(payload?.page) || 1);
			const pageSize = Math.min(200, Math.max(10, Number(payload?.pageSize) || 50));
			const where = [];
			const params = [];
			const { from, to } = rangeOf(payload);
			if (from !== null) {
				where.push("day >= ?");
				params.push(from);
			}
			if (to !== null) {
				where.push("day <= ?");
				params.push(to);
			}
			if (typeof payload?.model === "string" && payload.model !== "") {
				where.push("provider = ? AND model = ?");
				const [provider, model] = payload.model.split("\u0000");
				params.push(provider, model);
			}
			const clause = where.length === 0 ? "" : " WHERE " + where.join(" AND ");
			const total = Number(db.prepare("SELECT COUNT(*) AS n FROM usage_requests" + clause).get(...params).n);
			const rows = db
				.prepare("SELECT * FROM usage_requests" + clause + " ORDER BY ts DESC LIMIT ? OFFSET ?")
				.all(...params, pageSize, (page - 1) * pageSize);
			return {
				total,
				page,
				pageSize,
				rows: rows.map((row) => ({
					ts: Number(row.ts),
					provider: row.provider,
					model: row.model,
					input: Number(row.input_tokens),
					cacheRead: Number(row.cache_read_tokens),
					cacheWrite: Number(row.cache_write_tokens),
					output: Number(row.output_tokens),
					total: Number(row.total_tokens),
					ttft: row.ttft_ms === null ? null : Number(row.ttft_ms),
					decode: row.decode_ms === null ? null : Number(row.decode_ms),
					speed: row.speed === null ? null : Number(row.speed),
					peak: Number(row.peak) === 1,
					cost: row.cost === null ? null : Number(row.cost),
					costCurrency: row.cost_currency,
					costCny: row.cost_cny === null ? null : Number(row.cost_cny),
					costUsd: row.cost_usd === null ? null : Number(row.cost_usd)
				}))
			};
		},
		models() {
			return {
				priced: pricing.list().map((entry) => entry.model).filter((model, index, list) => list.indexOf(model) === index).sort(),
				aliases: aliases.list(),
				models: statements.models.all().map((row) => ({
					provider: row.provider,
					model: row.model,
					requests: Number(row.requests),
					tokens: Number(row.tokens),
					lastTs: Number(row.lastTs),
					priced: matchPricing(pricing.list(), row.provider, row.model, aliases.map()) !== null
				})),
				groups: groups()
			};
		},
		aliasSave(payload) {
			const alias = normalizeModelId(payload?.alias);
			const canonical = resolveModelId(payload?.canonical, aliases.map());
			if (alias === "") throw new Error("别名不能为空");
			if (canonical === "") throw new Error("目标模型不能为空");
			if (alias === canonical) throw new Error("别名与目标模型相同");
			if (aliases.map().get(canonical) === alias) throw new Error("这两条别名互为映射，会形成环");
			aliases.save(alias, canonical);
			return { aliases: aliases.list() };
		},
		aliasRemove(payload) {
			const alias = normalizeModelId(payload?.alias);
			if (alias === "") throw new Error("缺少 alias");
			aliases.remove(alias);
			return { aliases: aliases.list() };
		}
	};
}

/** 拉取某年的法定节假日；空 days 视为「尚未发布」，返回 null。 */
async function fetchHolidayYear(year) {
	for (const build of HOLIDAY_ENDPOINTS) {
		try {
			const response = await fetch(build(year), { signal: AbortSignal.timeout(8000) });
			if (!response.ok) continue;
			const body = await response.json();
			if (!Array.isArray(body?.days) || body.days.length === 0) continue;
			return body.days
				.filter((day) => typeof day?.date === "string")
				.map((day) => ({ date: day.date, name: typeof day.name === "string" ? day.name : "", off: day.isOffDay === true }));
		} catch {
			/* 换下一个源 */
		}
	}
	return null;
}

/** 读取请求体，超过上限直接断开。 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("请求体过大"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

//#endregion

export const inject = ["webServer"];

/** Host 插件体：建库、播种、订阅事件、回填历史、注册路由。 */
export function apply(ctx) {
	const db = openDatabase();
	const settings = createSettings(db);
	const meta = createMeta(db);
	const pricing = createPricingStore(db);
	const calendar = createCalendar(db);
	const aliases = createAliasStore(db);
	const logger = {
		warn: (message) => console.warn(message),
		info: (message) => console.info(message)
	};
	const fx = createFx(settings, logger);

	ctx.effect(() => () => {
		try {
			db.close();
		} catch {
			/* 关闭失败不影响卸载 */
		}
	}, "token-usage: database");

	if (settings.get("usd_cny_rate", "") === "") settings.set("usd_cny_rate", String(DEFAULT_FX));
	if (settings.get("display_currency", "") === "") settings.set("display_currency", "CNY");

	seedCalendar(db);
	void refreshCalendar(db, calendar, logger).catch(() => {});

	// 价格以 pricing.json 为准：每次启动整表替换（失败则保持原样）。
	const applied = applyPricingFile(pricing, meta, logger);
	if (applied.error !== null) {
		meta.set("pricing_error", applied.error);
		logger.warn("token-usage: pricing.json 解析失败，继续使用上一次的价格：" + applied.error);
	} else {
		meta.set("pricing_error", "");
		if (applied.applied > 0) logger.info("token-usage: 已按 pricing.json 载入 " + applied.applied + " 条价格");
		if (applied.usdCnyRate !== null && applied.usdCnyRate !== undefined && settings.get("usd_cny_rate_source", "") === "") {
			settings.set("usd_cny_rate", String(applied.usdCnyRate));
			settings.set("usd_cny_rate_source", "pricing.json");
		}
	}

	const api = createApi({ db, settings, meta, pricing, calendar, aliases, fx, logger });

	const insertRequest = db.prepare(`
		INSERT OR IGNORE INTO usage_requests
			(session_id, seq, ts, day, provider, model, input_tokens, cache_read_tokens, cache_write_tokens,
			 output_tokens, total_tokens, ttft_ms, decode_ms, speed, peak, cost, cost_currency, cost_cny, cost_usd, rate_used)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const insertFailure = db.prepare("INSERT OR IGNORE INTO attempt_failures (session_id, seq, ts, day, kind, code) VALUES (?, ?, ?, ?, ?, ?)");

	/** node:sqlite 没有 better-sqlite3 的 transaction 包装，自己开事务。 */
	const inTransaction = (fn) => {
		db.exec("BEGIN");
		try {
			fn();
			db.exec("COMMIT");
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* 回滚失败时保留原始错误 */
			}
			throw error;
		}
	};
	const writeRows = (result) => inTransaction(() => {
		for (const row of result.rows) {
			insertRequest.run(
				row.sessionId,
				row.seq,
				row.ts,
				row.day,
				row.provider,
				row.model,
				row.input,
				row.cacheRead,
				row.cacheWrite,
				row.output,
				row.total,
				row.ttft,
				row.decode,
				row.speed,
				row.peak ? 1 : 0,
				row.cost,
				row.costCurrency,
				row.costCny,
				row.costUsd,
				row.rateUsed
			);
		}
		for (const row of result.failures) insertFailure.run(row.sessionId, row.seq, row.ts, row.day, row.kind, row.code);
	});

	// 实时：每条落库的事件都走这里。step/start 按会话记住，用来算首字。
	const stepStarts = new Map();
	const onEvent = (session, event) => {
		try {
			if (event.type === "step/start") {
				stepStarts.set(session.id, Number(event.time));
				return;
			}
			if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return;
			const stepStart = stepStarts.get(session.id);
			if (event.type === "assistant/message") {
				const row = buildUsageRow({
					sessionId: session.id,
					event,
					stepStartTime: stepStart,
					pricing: matchPricing(pricing.list(), event.data?.message?.source?.provider, event.data?.message?.source?.model, aliases.map()),
					calendar: calendar.rule,
					fxRate: fx.current().rate
				});
				if (row !== null) writeRows({ rows: [row], failures: [] });
				return;
			}
			const failure = buildAttemptRow({ sessionId: session.id, event });
			if (failure !== null) writeRows({ rows: [], failures: [failure] });
		} catch (error) {
			logger.warn("token-usage: 处理事件失败：" + (error instanceof Error ? error.message : String(error)));
		}
	};
	ctx.on("session/event", onEvent);

	// 回填：只在有 sessionQuery 时进行。fork 出来的会话带父会话前缀，用事件指纹跳过，
	// 否则历史会被重复计价（本机实测多算约 1400 条）。
	ctx.inject(["sessionQuery"], (childCtx) => {
		// 每天最多全量扫一次：正常启动时实时链路已经覆盖，没必要每次都重读 200+ 份日志。
		if (meta.get("backfill_day") === dayKey(Date.now())) return;
		const backfill = async () => {
			const query = childCtx.sessionQuery;
			if (query === undefined || typeof query.listSessions !== "function") return;
			const listed = await query.listSessions();
			const headers = new Map(listed.map((record) => [record.header.id, record.header]));
			const inherited = new Map();
			for (const record of listed) {
				const header = record.header;
				if (header.isSeeded !== true || typeof header.parentSession !== "string" || !headers.has(header.parentSession)) continue;
				try {
					const parent = await query.readSession(header.parentSession);
					const prints = new Set();
					for (const event of parent.events) if (USAGE_TYPES.has(event.type)) prints.add(fingerprint(event));
					inherited.set(header.id, prints);
				} catch (error) {
					logger.warn("token-usage: 读取父会话失败：" + header.parentSession);
				}
			}
			let sessions = 0;
			for (const record of listed) {
				const id = record.header.id;
				try {
					const log = await query.readSession(id);
					const result = ingestEvents({
						sessionId: id,
						events: log.events,
						pricing: pricing.list(),
						aliases: aliases.map(),
						calendar: calendar.rule,
						fxRate: fx.current().rate,
						skip: inherited.get(id) ?? null
					});
					writeRows(result);
					sessions += 1;
				} catch (error) {
					logger.warn("token-usage: 回填会话失败 " + id + "：" + (error instanceof Error ? error.message : String(error)));
				}
			}
			meta.set("backfill_at", new Date().toISOString());
			meta.set("backfill_day", dayKey(Date.now()));
			meta.set("backfill_sessions", String(sessions));
		};
		backfill().catch((error) => logger.warn("token-usage: 回填失败：" + (error instanceof Error ? error.message : String(error))));
	});

	// 汇率：每天一次，后台进行，失败不阻塞任何功能。
	void fx.ensureDaily().catch(() => {});

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "prefix",
				path: ROUTE_PATH,
				handler: async (req, res) => {
					const send = (status, payload) => {
						res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
						res.end(JSON.stringify(payload));
					};
					if (req.method !== "POST") return send(405, { ok: false, error: "只接受 POST" });
					if (req.headers[CLIENT_HEADER] === undefined) return send(403, { ok: false, error: "缺少客户端标记" });
					let body;
					try {
						body = JSON.parse(await readBody(req));
					} catch (error) {
						return send(400, { ok: false, error: "请求体不是合法 JSON：" + (error instanceof Error ? error.message : String(error)) });
					}
					const action = typeof body?.action === "string" ? body.action : "";
					if (typeof api[action] !== "function") return send(400, { ok: false, error: "未知操作：" + action });
					try {
						const result = await api[action](body);
						return send(200, { ok: true, ...result });
					} catch (error) {
						return send(400, { ok: false, error: error instanceof Error ? error.message : String(error) });
					}
				}
			}),
		"token-usage: http route"
	);
}
