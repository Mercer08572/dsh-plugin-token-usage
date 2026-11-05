/**
 * Token 用量看板 —— 纯逻辑层。
 *
 * 这里不碰 ctx、不碰数据库：把「一条会话事件」折叠成「一行用量记录」，
 * 以及价格校验、峰谷判定与成本计算。Host（lib/index.js）只负责 IO，
 * 离线回放工具（tools/replay.mjs）也复用同一套函数，保证口径只有一份。
 *
 * 时区固定为 Asia/Shanghai：峰谷窗口与「哪一天」都按北京时间切分，
 * 不跟随系统时区，否则换个时区看历史，热力图与成本会整体漂移。
 */

/** 计价与分日统一使用的时区。 */
export const TZ = "Asia/Shanghai";

const DAY_FMT = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const TIME_FMT = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const WEEK_FMT = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });

/** 取一个时间戳在目标时区下的年月日/时分/星期。 */
function partsOf(fmt, ts) {
	const out = {};
	for (const part of fmt.formatToParts(new Date(ts))) out[part.type] = part.value;
	return out;
}

/** 本地自然日键 `YYYY-MM-DD`。 */
export function dayKey(ts) {
	const p = partsOf(DAY_FMT, ts);
	return `${p.year}-${p.month}-${p.day}`;
}

/** 当天的分钟数（0..1439）。峰谷窗口按这个值比较。 */
export function minutesOfDay(ts) {
	const p = partsOf(TIME_FMT, ts);
	// hour12:false 在午夜可能给出 "24"；归一到 0。
	const hour = Number(p.hour) % 24;
	return hour * 60 + Number(p.minute);
}

const WEEK_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 星期序号：周日 0，周六 6。 */
export function weekdayOf(ts) {
	return WEEK_INDEX[partsOf(WEEK_FMT, ts).weekday] ?? 0;
}

/** 是否周末。 */
export function isWeekend(ts) {
	const day = weekdayOf(ts);
	return day === 0 || day === 6;
}

/** `HH:MM` → 分钟；非法返回 null。 */
export function parseClock(text) {
	if (typeof text !== "string") return null;
	const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
	if (match === null) return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour > 23 || minute > 59) return null;
	return hour * 60 + minute;
}

/**
 * 解析一个时间段 `HH:MM-HH:MM`。允许跨零点（22:00-06:00），
 * 这种情况用 `crosses` 标记，判定时按「或」拆成两段。
 */
export function parseWindow(text) {
	if (typeof text !== "string") return null;
	const match = /^(.+?)-(.+)$/.exec(text.trim());
	if (match === null) return null;
	const start = parseClock(match[1]);
	const end = parseClock(match[2]);
	if (start === null || end === null || start === end) return null;
	return { start, end, crosses: start > end };
}

/** 一个窗口是否包含给定分钟数。 */
export function windowContains(win, minutes) {
	if (win.crosses) return minutes >= win.start || minutes < win.end;
	return minutes >= win.start && minutes < win.end;
}

/**
 * 归一化一份峰谷配置。缺省 = 关闭（全天峰价）。
 * `windows` 是「时钟区间」，`windowsMean` 决定区间内算峰还是算谷：
 * 这样既能表达「谷时很短」（谷窗口），也能表达「峰时很短」（峰窗口）。
 * `weekend` / `holiday` 决定整天的强制归属，`windows` 表示不作特殊处理、按时钟走。
 */
export function normalizePeakValley(raw, base) {
	const source = raw !== null && typeof raw === "object" ? raw : {};
	const fallback = base ?? {};
	const enabled = source.enabled ?? fallback.enabled ?? false;
	const rawWindows = Array.isArray(source.windows) ? source.windows : Array.isArray(fallback.windows) ? fallback.windows : [];
	const windows = [];
	for (const item of rawWindows) {
		// 数据库里存的是归一化后的对象（{start,end,crosses}），JSON 文件里写的是字符串；
		// 两种都要能吃，否则「读回来再归一化」会把窗口丢掉。
		const parsed = typeof item === "string" ? parseWindow(item) : isWindowObject(item) ? item : null;
		if (parsed !== null) windows.push(parsed);
	}
	const discount = clampNumber(source.discount ?? fallback.discount ?? 0.5, 0, 1);
	const windowsMean = oneOf(source.windowsMean ?? fallback.windowsMean, ["peak", "valley"], "peak");
	const weekend = oneOf(source.weekend ?? fallback.weekend, ["peak", "valley", "windows"], "windows");
	const holiday = oneOf(source.holiday ?? fallback.holiday, ["peak", "valley", "windows"], "windows");
	return { enabled: enabled === true, windows, windowsMean, discount, weekend, holiday };
}

/** 已经是归一化窗口对象的形状。 */
function isWindowObject(value) {
	return (
		value !== null &&
		typeof value === "object" &&
		Number.isFinite(value.start) &&
		Number.isFinite(value.end) &&
		value.start !== value.end
	);
}

function oneOf(value, allowed, fallback) {
	return allowed.includes(value) ? value : fallback;
}

function clampNumber(value, min, max) {
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric)) return min;
	return Math.min(max, Math.max(min, numeric));
}

/**
 * 判断某个时刻是否按峰价计费。
 * @param peakValley 归一化后的峰谷配置（可为 null）。
 * @param ts 请求开始时间戳。
 * @param dayRule `holiday` 法定节假日 / `workday` 调休补班日 / `normal` 普通日。
 */
export function isPeak(peakValley, ts, dayRule) {
	if (peakValley === null || peakValley === undefined || peakValley.enabled !== true) return true;
	// 法定节假日：整天按配置走，不再看时钟。
	if (dayRule === "holiday" && peakValley.holiday !== "windows") return peakValley.holiday === "peak";
	// 周末：整天按配置走。注意规则写的是「周一至周五」，所以调休补班日（日历里 off=false）
	// 仍然算周末 —— 想让它按工作时间计费，就把 weekend 设成 "windows"。
	if (isWeekend(ts) && peakValley.weekend !== "windows") return peakValley.weekend === "peak";
	const minutes = minutesOfDay(ts);
	let inside = false;
	for (const win of peakValley.windows) {
		if (windowContains(win, minutes)) {
			inside = true;
			break;
		}
	}
	return peakValley.windowsMean === "valley" ? !inside : inside;
}

/**
 * 扫描紧凑 assistant 流，取首个与最后一个 token 的时间戳。
 *
 * 流里有两代形态：
 *   - 紧凑记录：`{ type: "text-chunks", time0, dt: [...] }`，末 token = time0 + Σdt；
 *   - 完整分片：`{ type: "chunk", time, chunk: { type: "text-delta" } }`。
 * 只认 token 级增量，`block-start` / `usage` / `finish` 不参与。
 */
export function scanStream(stream) {
	let first = null;
	let last = null;
	if (!Array.isArray(stream)) return { first, last };
	for (const entry of stream) {
		if (entry === null || typeof entry !== "object") continue;
		const chunk = entry.chunk !== null && typeof entry.chunk === "object" ? entry.chunk : entry;
		const type = chunk.type;
		if (type === "reasoning-chunks" || type === "text-chunks" || type === "tool-call-chunks") {
			if (!Number.isFinite(entry.time0)) continue;
			if (first === null) first = entry.time0;
			let end = entry.time0;
			if (Array.isArray(entry.dt)) {
				for (const delta of entry.dt) end += Number(delta) || 0;
			}
			if (last === null || end > last) last = end;
			continue;
		}
		if (type === "text-delta" || type === "reasoning-delta" || type === "thinking-delta" || type === "tool-input-delta") {
			if (!Number.isFinite(entry.time)) continue;
			if (first === null) first = entry.time;
			if (last === null || entry.time > last) last = entry.time;
		}
	}
	return { first, last };
}

/** 从紧凑流里读终态：成功 / 失败 / 取消。没有 finish 视为被中断（取消）。 */
export function attemptOutcome(stream) {
	if (!Array.isArray(stream)) return { kind: "aborted", code: "INTERRUPTED" };
	for (let index = stream.length - 1; index >= 0; index -= 1) {
		const entry = stream[index];
		const chunk = entry !== null && typeof entry === "object" && entry.chunk !== null && typeof entry.chunk === "object" ? entry.chunk : entry;
		if (chunk?.type !== "finish") continue;
		const reason = chunk.reason ?? {};
		if (reason.kind === "error") return { kind: "error", code: typeof reason.failure?.code === "string" ? reason.failure.code : "UNKNOWN" };
		if (reason.kind === "aborted") return { kind: "aborted", code: "ABORTED" };
		return { kind: "done", code: null };
	}
	return { kind: "aborted", code: "INTERRUPTED" };
}

/** 非负整数收敛。 */
function countOf(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0;
}

/** 峰价下的单价表；谷价 = 峰价 × discount，或由显式 offPeakPrices 覆盖。 */
export function pricesAt(pricing, peak) {
	if (pricing === null || pricing === undefined) return null;
	if (peak) return pricing.prices;
	if (pricing.offPeakPrices !== null && pricing.offPeakPrices !== undefined) return pricing.offPeakPrices;
	const factor = pricing.peakValley?.discount ?? 0.5;
	return {
		input: pricing.prices.input * factor,
		cacheRead: pricing.prices.cacheRead * factor,
		cacheWrite: pricing.prices.cacheWrite * factor,
		output: pricing.prices.output * factor
	};
}

/**
 * 计算一次请求的成本。未定价（pricing 为空）返回 null —— 成本列留空，
 * 永远不要用 0 冒充「没花钱」。
 */
export function costOf(tokens, pricing, peak, fxRate) {
	if (pricing === null || pricing === undefined) return null;
	const prices = pricesAt(pricing, peak);
	const unit = pricing.unit === "per_1k" ? 1e3 : 1e6;
	const amount =
		(tokens.input / unit) * prices.input +
		(tokens.cacheRead / unit) * prices.cacheRead +
		(tokens.cacheWrite / unit) * prices.cacheWrite +
		(tokens.output / unit) * prices.output;
	const rate = Number.isFinite(fxRate) && fxRate > 0 ? fxRate : 7.1;
	const cny = pricing.currency === "USD" ? amount * rate : amount;
	const usd = pricing.currency === "USD" ? amount : amount / rate;
	return { amount, currency: pricing.currency, cny, usd, rate };
}

/**
 * 一条 `assistant/message` 事件 → 一行用量记录。
 * @returns 记录对象；事件没有 usage 时返回 null（失败/空结算不该进统计）。
 */
export function buildUsageRow({ sessionId, event, stepStartTime, pricing, calendar, fxRate }) {
	const data = event?.data ?? {};
	const usage = data.usage;
	if (usage === null || typeof usage !== "object") return null;
	const ts = Number.isFinite(stepStartTime) ? stepStartTime : Number(event.time);
	if (!Number.isFinite(ts)) return null;

	const message = data.message !== null && typeof data.message === "object" ? data.message : {};
	const source = message.source !== null && typeof message.source === "object" ? message.source : {};
	const provider = typeof source.provider === "string" ? source.provider : "";
	const model = typeof source.model === "string" ? source.model : "";

	const input = countOf(usage.inputTokens);
	const cacheRead = countOf(usage.cacheReadTokens);
	const cacheWrite = countOf(usage.cacheWriteTokens);
	const output = countOf(usage.outputTokens);
	const reported = countOf(usage.totalTokens);
	const total = reported > 0 ? reported : input + cacheRead + cacheWrite + output;

	const { first, last } = scanStream(data.stream);
	const ttft = first === null ? null : Math.max(0, first - ts);
	const decode = first === null || last === null ? null : Math.max(0, last - first);
	const speed = decode !== null && decode > 0 && output > 0 ? (output / decode) * 1000 : null;

	const day = dayKey(ts);
	const rule = typeof calendar === "function" ? calendar(day) : "normal";
	const peak = isPeak(pricing?.peakValley, ts, rule);
	const cost = costOf({ input, cacheRead, cacheWrite, output }, pricing, peak, fxRate);

	return {
		sessionId,
		seq: Number(event.seq) || 0,
		ts,
		day,
		provider,
		model,
		input,
		cacheRead,
		cacheWrite,
		output,
		total,
		ttft,
		decode,
		speed,
		peak,
		cost: cost === null ? null : cost.amount,
		costCurrency: cost === null ? null : cost.currency,
		costCny: cost === null ? null : cost.cny,
		costUsd: cost === null ? null : cost.usd,
		rateUsed: cost === null ? null : cost.rate
	};
}

/** 一条 `assistant/attempt` 事件 → 失败/取消记录；成功的 attempt 不落库。 */
export function buildAttemptRow({ sessionId, event }) {
	const outcome = attemptOutcome(event?.data?.stream);
	if (outcome.kind === "done") return null;
	const stream = Array.isArray(event?.data?.stream) ? event.data.stream : [];
	const firstChunk = stream.find((entry) => Number.isFinite(entry?.time));
	const ts = Number(firstChunk?.time ?? event.time);
	if (!Number.isFinite(ts)) return null;
	return {
		sessionId,
		seq: Number(event.seq) || 0,
		ts,
		day: dayKey(ts),
		kind: outcome.kind,
		code: outcome.code
	};
}

//#region 价格文件校验

const PRICE_FIELDS = ["input", "cacheRead", "cacheWrite", "output"];
const MODEL_KEYS = new Set(["provider", "model", "currency", "unit", "prices", "offPeakPrices", "peakValley"]);

/** 校验失败时抛出，message 里带 JSON 路径，方便对着文件改。 */
function invalid(path, message) {
	throw new Error(`pricing.json ${path}: ${message}`);
}

function ensureObject(value, path) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "必须是对象");
	return value;
}

/** `_` 开头的键当注释，校验与导入都忽略。 */
function isComment(key) {
	return key.startsWith("_");
}

function checkUnknownKeys(object, allowed, path) {
	for (const key of Object.keys(object)) {
		if (isComment(key)) continue;
		if (!allowed.has(key)) invalid(path, `未知字段 "${key}"`);
	}
}

function validatePrices(raw, path, required) {
	const object = ensureObject(raw, path);
	checkUnknownKeys(object, new Set(PRICE_FIELDS), path);
	const out = {};
	for (const field of PRICE_FIELDS) {
		const value = object[field];
		if (value === undefined) {
			if (required.includes(field)) invalid(path, `缺少 "${field}"`);
			out[field] = 0;
			continue;
		}
		const numeric = Number(value);
		if (!Number.isFinite(numeric) || numeric < 0) invalid(`${path}.${field}`, "必须是非负数字");
		out[field] = numeric;
	}
	return out;
}

function validatePeakValley(raw, path, base) {
	if (raw === undefined) return normalizePeakValley(null, base);
	const object = ensureObject(raw, path);
	checkUnknownKeys(object, new Set(["enabled", "windows", "windowsMean", "discount", "weekend", "holiday"]), path);
	if (object.enabled !== undefined && typeof object.enabled !== "boolean") invalid(`${path}.enabled`, "必须是布尔值");
	if (object.windows !== undefined) {
		if (!Array.isArray(object.windows)) invalid(`${path}.windows`, "必须是字符串数组");
		for (const [index, item] of object.windows.entries()) {
			if (parseWindow(item) === null) invalid(`${path}.windows[${index}]`, `无法解析时间窗 "${String(item)}"（格式 HH:MM-HH:MM）`);
		}
	}
	for (const field of ["windowsMean", "weekend", "holiday"]) {
		if (object[field] === undefined) continue;
		const allowed = field === "windowsMean" ? ["peak", "valley"] : ["peak", "valley", "windows"];
		if (!allowed.includes(object[field])) invalid(`${path}.${field}`, `必须是 ${allowed.join(" / ")}`);
	}
	if (object.discount !== undefined) {
		const numeric = Number(object.discount);
		if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) invalid(`${path}.discount`, "必须在 0~1 之间");
	}
	return normalizePeakValley(object, base);
}

/**
 * 严格校验价格文件：未知字段、缺字段、负价、非法时间窗一律报错并指出路径。
 * 整份文件要么全部通过，要么一条都不导入 —— 不允许半个价格表进库。
 */
export function parsePricingFile(text) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new Error("pricing.json: 不是合法 JSON（" + (error instanceof Error ? error.message : String(error)) + "）");
	}
	const root = ensureObject(raw, "根");
	checkUnknownKeys(root, new Set(["schemaVersion", "usdCnyRate", "defaults", "models"]), "根");
	if (root.schemaVersion !== 1) invalid("schemaVersion", "当前只支持 1");
	const defaults = root.defaults === undefined ? {} : ensureObject(root.defaults, "defaults");
	checkUnknownKeys(defaults, new Set(["currency", "unit", "peakValley"]), "defaults");
	const defaultCurrency = oneOf(defaults.currency, ["CNY", "USD"], "CNY");
	const defaultUnit = oneOf(defaults.unit, ["per_1m", "per_1k"], "per_1m");
	const defaultPeakValley = normalizePeakValley(defaults.peakValley, null);
	if (!Array.isArray(root.models)) invalid("models", "必须是数组");

	const models = [];
	for (const [index, entry] of root.models.entries()) {
		const path = `models[${index}]`;
		const object = ensureObject(entry, path);
		checkUnknownKeys(object, MODEL_KEYS, path);
		if (typeof object.provider !== "string" || object.provider.trim() === "") invalid(`${path}.provider`, "必须是非空字符串（任意 provider 用 \"*\"）");
		if (typeof object.model !== "string" || object.model.trim() === "") invalid(`${path}.model`, "必须是非空字符串");
		const currency = oneOf(object.currency ?? defaultCurrency, ["CNY", "USD"], defaultCurrency);
		const unit = oneOf(object.unit ?? defaultUnit, ["per_1m", "per_1k"], defaultUnit);
		const prices = validatePrices(object.prices, `${path}.prices`, ["input", "cacheRead", "output"]);
		const offPeakPrices = object.offPeakPrices === undefined ? null : validatePrices(object.offPeakPrices, `${path}.offPeakPrices`, []);
		const peakValley = validatePeakValley(object.peakValley, `${path}.peakValley`, defaultPeakValley);
		models.push({
			provider: object.provider.trim(),
			model: object.model.trim(),
			currency,
			unit,
			prices,
			offPeakPrices,
			peakValley
		});
	}
	const rate = Number(root.usdCnyRate);
	return { models, usdCnyRate: Number.isFinite(rate) && rate > 0 ? rate : null };
}

//#endregion

//#region 价格匹配

/**
 * 模型 id 归一化：去空白、转小写、去掉 vendor 前缀。
 * 例：`DeepSeek/DeepSeek-V4.1-Flash` → `deepseek-v4.1-flash`。
 * 只做这两件事：能靠格式判断的自动合并；`-fast` / `-mini` 这类后缀**不动**，
 * 因为它们是不同价位的模型，误合并会把钱算错。`*` 单独保留（表示任意模型）。
 */
export function normalizeModelId(id) {
	const raw = String(id ?? "").trim().toLowerCase();
	if (raw === "" || raw === "*") return raw;
	const slash = raw.lastIndexOf("/");
	return slash >= 0 ? raw.slice(slash + 1) : raw;
}

/** 归一化之后再查别名表：别名和规范名都按归一化形式存放。 */
export function resolveModelId(id, aliases) {
	const normalized = normalizeModelId(id);
	if (normalized === "" || normalized === "*") return normalized;
	const mapped = aliases instanceof Map ? aliases.get(normalized) : undefined;
	return mapped === undefined ? normalized : mapped;
}

/**
 * 在价格表里为 (provider, model) 找一条规则。
 * 计价维度是「模型」，provider 只是可选覆盖：
 *   provider 精确 + model 精确 > provider 精确 + `*` > provider `*` + model 精确 > 双 `*`。
 * provider 与 model 都按归一化后的形式比较，所以 `google/gemini-3.8-flash`
 * 与 `gemini-3.8-flash` 命中同一条规则。
 */
export function matchPricing(pricings, provider, model, aliases) {
	if (!Array.isArray(pricings) || pricings.length === 0) return null;
	const target = resolveModelId(model, aliases);
	const providerKey = String(provider ?? "").trim().toLowerCase();
	let best = null;
	let bestScore = -1;
	for (const pricing of pricings) {
		const rawProvider = String(pricing.provider ?? "").trim();
		const providerExact = rawProvider !== "*" && rawProvider.toLowerCase() === providerKey;
		const providerAny = rawProvider === "*";
		if (!providerExact && !providerAny) continue;
		const pricingModel = pricing.model === "*" ? "*" : resolveModelId(pricing.model, aliases);
		const modelExact = pricingModel === target;
		const modelAny = pricingModel === "*";
		if (!modelExact && !modelAny) continue;
		const score = (providerExact ? 2 : 0) + (modelExact ? 1 : 0);
		if (score > bestScore) {
			best = pricing;
			bestScore = score;
		}
	}
	return best;
}

//#endregion
