import logConst, { AE_DATASET, LOG_LIMIT, LOG_PAGE_MAX, LOG_ARCHIVE_PREFIX, LOG_DEFAULT_CONFIG } from '../const/log-const';
import reqUtils from '../utils/req-utils';
import settingService from '../service/setting-service';

/**
 * 日志服务
 *
 * 职责：
 *  1. record()      请求结束时写 AE 明细（全量），命中审计规则时同时写 D1
 *  2. writeError()  异常时补写一条审计（error 级别）
 *  3. 查询接口：AE 明细（SQL API）/ D1 审计 / D1 每日聚合
 *  4. dailyJob()    定时任务：聚合落库 + R2 归档 + 过期清理
 */

/**
 * 按 UTF-8 字节数截断字符串。
 *
 * 为什么按字节：Analytics Engine 对单个数据点所有 blob 的合计限制是 16 KB（字节），
 * 旧实现按 String.length（UTF-16 字符数）截断，中文/emoji 场景下会突破限制，
 * 导致 writeDataPoint 抛错、整条日志被静默丢弃。
 */
function truncateBytes(str, maxBytes) {
	if (str === null || str === undefined) {
		return '';
	}
	const s = typeof str === 'string' ? str : JSON.stringify(str);
	if (!s) {
		return '';
	}

	const encoder = new TextEncoder();

	// 快速路径：UTF-8 每个字符最多 4 字节，先按 maxBytes 个字符粗截，足以覆盖绝大多数情况
	const rough = s.length > maxBytes ? s.slice(0, maxBytes) : s;
	if (encoder.encode(rough).length <= maxBytes) {
		return rough;
	}

	// 精确回退：二分查找能塞进 maxBytes 的最大字符数
	let lo = 0;
	let hi = rough.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (encoder.encode(rough.slice(0, mid)).length <= maxBytes) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return rough.slice(0, lo) + '...(truncated)';
}

function statusGroup(status) {
	if (!status) {
		return '0xx';
	}
	return `${Math.floor(status / 100)}xx`;
}

function safeJsonParse(text) {
	try {
		return JSON.parse(text);
	} catch (e) {
		return null;
	}
}

/** 请求体里可能带敏感字段，按用户要求默认不脱敏，仅做长度截断 */
function serializeBody(body) {
	if (body === null || body === undefined || body === '') {
		return '';
	}
	return truncateBytes(body, LOG_LIMIT.BODY);
}

const logService = {

	/** 读取日志配置（setting 表 → KV 缓存） */
	async config(c) {
		let setting;
		try {
			setting = await settingService.query(c);
		} catch (e) {
			setting = null;
		}
		return {
			logEnabled: Number(setting?.logEnabled ?? LOG_DEFAULT_CONFIG.logEnabled),
			logAuditEnabled: Number(setting?.logAuditEnabled ?? LOG_DEFAULT_CONFIG.logAuditEnabled),
			logReqDays: Number(setting?.logReqDays ?? LOG_DEFAULT_CONFIG.logReqDays),
			logAuditDays: Number(setting?.logAuditDays ?? LOG_DEFAULT_CONFIG.logAuditDays),
			logArchive: Number(setting?.logArchive ?? LOG_DEFAULT_CONFIG.logArchive)
		};
	},

	/** 修改日志配置 */
	async setConfig(c, body) {
		const patch = {};

		if (body.logEnabled !== undefined) patch.logEnabled = Number(body.logEnabled) ? 1 : 0;
		if (body.logAuditEnabled !== undefined) patch.logAuditEnabled = Number(body.logAuditEnabled) ? 1 : 0;
		if (body.logReqDays !== undefined) patch.logReqDays = Math.max(Number(body.logReqDays) || 0, 0);
		if (body.logAuditDays !== undefined) patch.logAuditDays = Math.max(Number(body.logAuditDays) || 0, 0);
		if (body.logArchive !== undefined) patch.logArchive = Number(body.logArchive) ? 1 : 0;

		if (!Object.keys(patch).length) {
			return;
		}

		await c.env.db.prepare(`
			UPDATE setting SET
				log_enabled = COALESCE(?, log_enabled),
				log_audit_enabled = COALESCE(?, log_audit_enabled),
				log_req_days = COALESCE(?, log_req_days),
				log_audit_days = COALESCE(?, log_audit_days),
				log_archive = COALESCE(?, log_archive)
		`).bind(
			patch.logEnabled ?? null,
			patch.logAuditEnabled ?? null,
			patch.logReqDays ?? null,
			patch.logAuditDays ?? null,
			patch.logArchive ?? null
		).run();

		// 刷新 KV 缓存，让配置立即生效
		await settingService.refresh(c);
	},

	/** AE 写入：全量请求明细 */
	writeDataPoint(env, point) {
		try {
			if (!env.LOGS) {
				console.error('AE writeDataPoint skipped: LOGS binding missing');
				return false;
			}
			env.LOGS.writeDataPoint(point);
			return true;
		} catch (e) {
			// 最常见原因是单个数据点 blob 合计超过 16 KB，此时整条日志会被丢弃
			console.error('AE writeDataPoint failed:', e.message);
			return false;
		}
	},

	/**
	 * 记录一次请求
	 * @param c Hono Context
	 * @param ctxObj { start, body, error, status, responseLength }
	 */
	async record(c, ctxObj) {
		const env = c.env;
		const user = (() => {
			try {
				return c.get('user');
			} catch (e) {
				return null;
			}
		})();

		const path = c.req.path;
		const method = c.req.method;
		const status = ctxObj.status || (ctxObj.error ? (ctxObj.error.code || 500) : 200);
		const duration = Date.now() - ctxObj.start;
		const ua = truncateBytes(c.req.header('user-agent') || '', LOG_LIMIT.UA);
		const ip = reqUtils.getIp(c);
		const country = c.req.header('cf-ipcountry') || '';
		const colo = c.req.header('cf-ray') ? (c.req.header('cf-ray').split('-')[1] || '') : '';
		const rayId = c.req.header('cf-ray') || '';

		let config = null;
		try {
			config = await this.config(c);
		} catch (e) {
			config = { ...LOG_DEFAULT_CONFIG };
		}

		const auditRule = logConst.matchAuditRule(path, method);
		const errMsg = ctxObj.error ? truncateBytes(ctxObj.error.stack || ctxObj.error.message || String(ctxObj.error), LOG_LIMIT.ERROR) : '';

		// 1) AE 明细（全量）
		if (config.logEnabled === 1) {
			this.writeDataPoint(env, {
				indexes: [String(user?.userId ?? 0)],
				blobs: [
					new Date().toISOString(),          // blob1 时间
					method,                            // blob2
					path,                              // blob3
					String(status),                    // blob4
					user?.email || '',                 // blob5
					String(user?.userId ?? ''),        // blob6
					ip,                                // blob7
					ua,                                // blob8
					country,                           // blob9
					colo,                              // blob10
					rayId,                             // blob11
					auditRule?.action || '',           // blob12
					auditRule?.module || '',           // blob13
					errMsg,                            // blob14
					serializeBody(ctxObj.body),        // blob15
					truncateBytes(c.req.header('referer') || '', LOG_LIMIT.REFERER) // blob16
				],
				doubles: [
					duration,                          // double1 耗时 ms
					status,                            // double2 状态码
					ctxObj.bodyLength || 0,            // double3 请求体字节
					ctxObj.responseLength || 0         // double4 响应字节
				]
			});
		}

		// 2) D1 审计（仅关键操作 / 异常）
		const needAudit = (auditRule && config.logAuditEnabled === 1) || !!ctxObj.error;
		if (needAudit) {
			await this.writeAudit(env, {
				userId: user?.userId ?? null,
				userEmail: user?.email || '',
				action: ctxObj.error && !auditRule ? 'error' : auditRule.action,
				module: ctxObj.error && !auditRule ? 'system' : auditRule.module,
				method,
				path,
				status,
				duration,
				ip,
				ua,
				country,
				rayId,
				target: ctxObj.target || '',
				detail: serializeBody(ctxObj.body),
				error: errMsg,
				createdAt: new Date().toISOString()
			});
		}
	},

	/** 写一条 D1 审计 */
	async writeAudit(env, row) {
		try {
			await env.db.prepare(`
				INSERT INTO audit_log
				(user_id, user_email, action, module, method, path, status, duration, ip, ua, country, ray_id, target, detail, error, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).bind(
				row.userId ?? null,
				row.userEmail || '',
				row.action || '',
				row.module || '',
				row.method || '',
				row.path || '',
				row.status ?? 0,
				row.duration ?? 0,
				row.ip || '',
				row.ua || '',
				row.country || '',
				row.rayId || '',
				row.target || '',
				row.detail || '',
				row.error || '',
				row.createdAt || new Date().toISOString()
			).run();
			return true;
		} catch (e) {
			console.error('audit insert failed:', e.message);
			return false;
		}
	},

	/**
	 * 异常兜底审计。
	 *
	 * 现状说明：Hono 的 onError 会把异常挂到 context（c.set('logError', err)），
	 * 由 log-middleware 统一读取并记录，因此正常情况下本方法不会被调用。
	 * 保留它作为「中间件链路本身出问题」时的最后一道兜底。
	 */
	async writeError(env, c, err) {
		try {
			let user = null;
			try {
				user = c.get('user');
			} catch (e) { /* ignore */ }

			await this.writeAudit(env, {
				userId: user?.userId ?? null,
				userEmail: user?.email || '',
				action: 'error',
				module: 'system',
				method: c.req.method,
				path: c.req.path,
				status: err?.code || 500,
				duration: 0,
				ip: reqUtils.getIp(c),
				ua: truncateBytes(c.req.header('user-agent') || '', LOG_LIMIT.UA),
				country: c.req.header('cf-ipcountry') || '',
				rayId: c.req.header('cf-ray') || '',
				error: truncateBytes(err?.stack || err?.message || String(err), LOG_LIMIT.ERROR),
				createdAt: new Date().toISOString()
			});
		} catch (e) {
			console.error('writeError failed:', e.message);
		}
	},

	/* ============================ AE 查询 ============================ */

	/** 走 AE SQL API 查询明细 */
	async aeQuery(env, sql) {
		const accountId = env.ae_account_id;
		// 兼容两种命名：线上 secret 名为 AE_QUERY_TOKEN（大写），
		// 而 wrangler.toml 里的 ae_account_id 是小写。
		// 历史版本只读 env.ae_query_token，因绑定名大小写敏感导致取到 undefined，
		// 三个 /log/req/* 接口全部报 502。
		const token = env.ae_query_token || env.AE_QUERY_TOKEN;

		if (!accountId || !token) {
			const err = new Error('Analytics Engine 查询未配置（缺少 ae_account_id / ae_query_token）');
			err.code = 502;
			throw err;
		}

		const resp = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
			{
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${token}`,
					'Content-Type': 'text/plain'
				},
				body: sql
			}
		);

		const text = await resp.text();

		if (!resp.ok) {
			const err = new Error(`AE 查询失败(${resp.status}): ${truncateBytes(text, 300)}`);
			err.code = resp.status === 403 ? 403 : 502;
			throw err;
		}

		const json = safeJsonParse(text);
		if (!json) {
			const err = new Error('AE 查询返回非 JSON：' + truncateBytes(text, 200));
			err.code = 502;
			throw err;
		}
		return json;
	},

	/** 明细列表：AE 不支持 OFFSET，用时间游标翻页 */
	async reqList(c, params) {
		const { keyword, method, pathPrefix, onlyError, userId, cursor, pageSize } = params;
		const startTime = this.normalizeTime(params.startTime);
		const endTime = this.normalizeTime(params.endTime);
		const cursorTime = this.normalizeTime(cursor);
		const limit = Math.min(Number(pageSize) || 50, LOG_PAGE_MAX);

		const where = [];

		if (startTime) {
			where.push(`timestamp >= toDateTime('${this.escape(startTime)}')`);
		}
		if (endTime) {
			where.push(`timestamp <= toDateTime('${this.escape(endTime)}')`);
		}
		if (cursorTime) {
			where.push(`timestamp < toDateTime('${this.escape(cursorTime)}')`);
		}
		if (method) {
			where.push(`blob2 = '${this.escape(method.toUpperCase())}'`);
		}
		if (pathPrefix) {
			where.push(`blob3 LIKE '${this.escape(pathPrefix)}%'`);
		}
		if (userId) {
			where.push(`blob6 = '${this.escape(String(userId))}'`);
		}
		if (onlyError === '1' || onlyError === true) {
			where.push(`double2 >= 400`);
		}
		if (keyword) {
			const kw = this.escape(keyword);
			where.push(`(blob3 LIKE '%${kw}%' OR blob5 LIKE '%${kw}%' OR blob7 LIKE '%${kw}%' OR blob8 LIKE '%${kw}%' OR blob14 LIKE '%${kw}%' OR blob15 LIKE '%${kw}%')`);
		}

		const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

		const sql = `
			SELECT
				timestamp AS time,
				blob2 AS method,
				blob3 AS path,
				double2 AS status,
				double1 AS duration,
				blob5 AS user_email,
				blob6 AS user_id,
				blob7 AS ip,
				blob8 AS ua,
				blob9 AS country,
				blob10 AS colo,
				blob11 AS ray_id,
				blob12 AS action,
				blob13 AS module,
				blob14 AS error,
				blob15 AS body,
				_sample_interval AS sample_interval
			FROM ${AE_DATASET}
			${whereSql}
			ORDER BY time DESC
			LIMIT ${limit}
		`;

		const data = await this.aeQuery(c.env, sql);
		return data.data || [];
	},

	/** 明细统计（AE 侧按条件聚合，按采样权重还原真实量） */
	async reqOverview(c, params) {
		const startTime = this.normalizeTime(params.startTime);
		const endTime = this.normalizeTime(params.endTime);
		const where = [];
		if (startTime) where.push(`timestamp >= toDateTime('${this.escape(startTime)}')`);
		if (endTime) where.push(`timestamp <= toDateTime('${this.escape(endTime)}')`);

		const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

		// AE 会自动采样，必须用 _sample_interval 还原真实量，
		// 否则 count()/sum()/avg() 的结果会系统性偏低。
		const sql = `
			SELECT
				sum(_sample_interval) AS total,
				sum(if(double2 >= 400, _sample_interval, 0)) AS errors,
				sum(double1 * _sample_interval) / sum(_sample_interval) AS avg_duration,
				max(double1) AS max_duration
			FROM ${AE_DATASET}
			${whereSql}
		`;
		const data = await this.aeQuery(c.env, sql);
		return (data.data && data.data[0]) || { total: 0, errors: 0, avg_duration: 0, max_duration: 0 };
	},

	/** AE 侧按路径聚合（给趋势图用），同样按采样权重还原 */
	async reqTopPaths(c, params) {
		const startTime = this.normalizeTime(params.startTime);
		const endTime = this.normalizeTime(params.endTime);
		const where = [];
		if (startTime) where.push(`timestamp >= toDateTime('${this.escape(startTime)}')`);
		if (endTime) where.push(`timestamp <= toDateTime('${this.escape(endTime)}')`);

		const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

		const sql = `
			SELECT
				blob3 AS path,
				sum(_sample_interval) AS total,
				sum(if(double2 >= 400, _sample_interval, 0)) AS errors,
				sum(double1 * _sample_interval) / sum(_sample_interval) AS avg_duration
			FROM ${AE_DATASET}
			${whereSql}
			GROUP BY path
			ORDER BY total DESC
			LIMIT 20
		`;
		const data = await this.aeQuery(c.env, sql);
		return data.data || [];
	},

	/**
	 * SQL 值转义。
	 * AE 查询走字符串拼接，必须同时处理单引号与反斜杠：
	 * ClickHouse 的字符串字面量同时支持 '' 与 \' 两种转义，
	 * 只把 ' 换成 '' 而不管 \，会留下 \' 提前闭合字符串的注入面。
	 * 顺序很重要：必须先转义反斜杠，再转义单引号。
	 */
	escape(value) {
		return String(value)
			.replace(/\\/g, '\\\\')
			.replace(/'/g, "''");
	},

	/** 校验时间参数，非法直接返回 null，避免拼出非法 SQL 让整个查询报错 */
	normalizeTime(value) {
		if (!value) {
			return null;
		}
		const s = String(value).trim();
		// 允许 'YYYY-MM-DD'、'YYYY-MM-DD HH:mm:ss'、'YYYY-MM-DDTHH:mm:ss(.sss)?Z?'
		if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/.test(s)) {
			return null;
		}
		return s;
	},

	/* ============================ D1 查询 ============================ */

	async auditList(c, params) {
		const pageNum = Math.max(Number(params.pageNum) || 1, 1);
		const pageSize = Math.min(Number(params.pageSize) || 20, 100);
		const offset = (pageNum - 1) * pageSize;

		const where = [];
		const binds = [];

		if (params.action) {
			where.push('action = ?');
			binds.push(params.action);
		}
		if (params.module) {
			where.push('module = ?');
			binds.push(params.module);
		}
		if (params.userId) {
			where.push('user_id = ?');
			binds.push(Number(params.userId));
		}
		if (params.startTime) {
			where.push('created_at >= ?');
			binds.push(params.startTime);
		}
		if (params.endTime) {
			where.push('created_at <= ?');
			binds.push(params.endTime);
		}
		if (params.keyword) {
			const kw = `%${params.keyword}%`;
			where.push('(user_email LIKE ? OR ip LIKE ? OR path LIKE ? OR action LIKE ? OR detail LIKE ? OR error LIKE ?)');
			binds.push(kw, kw, kw, kw, kw, kw);
		}

		const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

		const countRow = await c.env.db.prepare(`SELECT COUNT(*) AS total FROM audit_log ${whereSql}`)
			.bind(...binds).first();

		const listSql = `
			SELECT log_id, user_id, user_email, action, module, method, path, status, duration,
			       ip, country, ray_id, target, created_at,
			       substr(detail, 1, 200) AS detail_preview,
			       substr(error, 1, 200) AS error_preview
			FROM audit_log
			${whereSql}
			ORDER BY log_id DESC
			LIMIT ? OFFSET ?
		`;

		const { results } = await c.env.db.prepare(listSql).bind(...binds, pageSize, offset).all();

		return { total: countRow?.total || 0, list: results || [] };
	},

	async auditDetail(c, logId) {
		return await c.env.db.prepare(`SELECT * FROM audit_log WHERE log_id = ?`).bind(Number(logId)).first();
	},

	async auditExport(c, params) {
		const where = [];
		const binds = [];

		if (params.action) {
			where.push('action = ?');
			binds.push(params.action);
		}
		if (params.module) {
			where.push('module = ?');
			binds.push(params.module);
		}
		if (params.startTime) {
			where.push('created_at >= ?');
			binds.push(params.startTime);
		}
		if (params.endTime) {
			where.push('created_at <= ?');
			binds.push(params.endTime);
		}
		if (params.keyword) {
			const kw = `%${params.keyword}%`;
			where.push('(user_email LIKE ? OR ip LIKE ? OR path LIKE ? OR action LIKE ? OR detail LIKE ? OR error LIKE ?)');
			binds.push(kw, kw, kw, kw, kw, kw);
		}

		const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
		const limit = Math.min(Number(params.limit) || 5000, 20000);

		const { results } = await c.env.db.prepare(`
			SELECT log_id, created_at, user_id, user_email, action, module, method, path, status,
			       duration, ip, country, ray_id, target, detail, error
			FROM audit_log
			${whereSql}
			ORDER BY log_id DESC
			LIMIT ${limit}
		`).bind(...binds).all();

		return results || [];
	},

	async statList(c, params) {
		const days = Math.min(Number(params.days) || 30, 365);
		// 按 total 加权，避免各路径的日平均被简单平均后失真
		const { results } = await c.env.db.prepare(`
			SELECT stat_date, SUM(total) AS total, SUM(errors) AS errors,
			       CAST(SUM(avg_duration * total) / NULLIF(SUM(total), 0) AS INTEGER) AS avg_duration,
			       MAX(max_duration) AS max_duration
			FROM log_stat_daily
			WHERE stat_date >= date('now', ?)
			GROUP BY stat_date
			ORDER BY stat_date ASC
		`).bind(`-${days} days`).all();
		return results || [];
	},

	async statPathList(c, params) {
		const days = Math.min(Number(params.days) || 7, 365);
		const { results } = await c.env.db.prepare(`
			SELECT path, SUM(total) AS total, SUM(errors) AS errors,
			       CAST(SUM(avg_duration * total) / NULLIF(SUM(total), 0) AS INTEGER) AS avg_duration
			FROM log_stat_daily
			WHERE stat_date >= date('now', ?)
			GROUP BY path
			ORDER BY total DESC
			LIMIT 20
		`).bind(`-${days} days`).all();
		return results || [];
	},

	/** 清理审计日志 */
	async clearAudit(c, params) {
		const { beforeDays, action, module } = params;

		if (beforeDays === undefined && !action && !module) {
			await c.env.db.prepare(`DELETE FROM audit_log`).run();
			return -1;
		}

		const where = [];
		const binds = [];
		if (beforeDays !== undefined && beforeDays !== null && beforeDays !== '') {
			const n = Number(beforeDays);
			if (Number.isFinite(n) && n >= 0) {
				// created_at 写入的是 ISO 8601（2026-09-30T22:06:00.000Z），
				// 而 datetime('now') 返回的是空格分隔格式（2026-09-30 22:06:00）。
				// 字符串比较时 'T'(0x54) > ' '(0x20)，同一天的记录永远"大于"截止值，
				// 导致清理被推迟约一天。这里统一用 strftime 生成同格式的 UTC 时间。
				where.push(`created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`);
				binds.push(`-${n} days`);
			}
		}
		if (action) {
			where.push('action = ?');
			binds.push(action);
		}
		if (module) {
			where.push('module = ?');
			binds.push(module);
		}

		const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
		const res = await c.env.db.prepare(`DELETE FROM audit_log ${whereSql}`).bind(...binds).run();
		return res.meta?.changes ?? 0;
	},

	/* ============================ 定时任务 ============================ */

	/** 每日任务：AE 聚合落 D1 → R2 归档 → 过期清理 */
	async dailyJob(env, c) {
		const today = new Date();
		const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);
		const dateStr = yesterday.toISOString().slice(0, 10);

		// 1) 聚合昨日数据（从 AE 拉，失败不影响其他步骤）
		try {
			const startTime = `${dateStr} 00:00:00`;
			const endTime = `${dateStr} 23:59:59`;

			const sql = `
				SELECT
					blob3 AS path,
					blob2 AS method,
					if(double2 >= 500, '5xx', if(double2 >= 400, '4xx', if(double2 >= 300, '3xx', '2xx'))) AS status_group,
					sum(_sample_interval) AS total,
					sum(if(double2 >= 400, _sample_interval, 0)) AS errors,
					sum(double1 * _sample_interval) / sum(_sample_interval) AS avg_duration,
					max(double1) AS max_duration
				FROM ${AE_DATASET}
				WHERE timestamp >= toDateTime('${startTime}') AND timestamp <= toDateTime('${endTime}')
				GROUP BY path, method, status_group
				LIMIT 5000
			`;

			const data = await this.aeQuery(env, sql);
			const rows = data.data || [];

			if (rows.length) {
				const stmts = rows.map(r => env.db.prepare(`
					INSERT INTO log_stat_daily (stat_date, path, method, status_group, total, errors, avg_duration, max_duration, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(stat_date, path, method, status_group)
					DO UPDATE SET total = excluded.total, errors = excluded.errors,
					              avg_duration = excluded.avg_duration, max_duration = excluded.max_duration
				`).bind(
					dateStr, r.path, r.method, r.status_group,
					Math.round(r.total), Math.round(r.errors),
					Math.round(r.avg_duration || 0), Math.round(r.max_duration || 0),
					new Date().toISOString()
				));

				// D1 batch 一次最多 100 条左右比较稳，分批提交
				for (let i = 0; i < stmts.length; i += 50) {
					await env.db.batch(stmts.slice(i, i + 50));
				}
				console.log(`log stat aggregated: ${dateStr}, ${rows.length} rows`);
			}
		} catch (e) {
			console.error('log stat aggregate failed:', e.message);
		}

		// 2) R2 归档昨日审计 + 明细（受 log_archive 开关控制）
		try {
			const archiveRow = await env.db.prepare(`SELECT log_archive FROM setting LIMIT 1`).first();
			const archiveEnabled = Number(archiveRow?.log_archive ?? 1) === 1;
			if (archiveEnabled) {
				await this.archiveToR2(env, dateStr);
			} else {
				console.log('log archive disabled (log_archive=0), skip');
			}
		} catch (e) {
			console.error('log archive failed:', e.message);
		}

		// 3) 过期清理（审计；AE 明细由 AE 自身 3 个月过期）
		try {
			await this.cleanup(env);
		} catch (e) {
			console.error('log cleanup failed:', e.message);
		}
	},

	async archiveToR2(env, dateStr) {
		if (!env.r2) {
			console.warn('R2 未绑定，跳过日志归档');
			return;
		}

		// 审计归档
		const { results: auditRows } = await env.db.prepare(`
			SELECT * FROM audit_log
			WHERE created_at >= ? AND created_at <= ?
			ORDER BY log_id ASC
			LIMIT 50000
		`).bind(`${dateStr}T00:00:00`, `${dateStr}T23:59:59.999Z`).all();

		if (auditRows && auditRows.length) {
			const lines = auditRows.map(r => JSON.stringify(r)).join('\n');
			await env.r2.put(`${LOG_ARCHIVE_PREFIX}${dateStr}/audit.jsonl`, lines, {
				httpMetadata: { contentType: 'application/x-ndjson' }
			});
			console.log(`archived audit: ${dateStr}, ${auditRows.length} rows`);
		}

		// 明细归档（从 AE 拉昨日全量）
		try {
			const sql = `
				SELECT timestamp AS time,
				       blob2 AS method, blob3 AS path, double2 AS status, double1 AS duration,
				       blob5 AS user_email, blob6 AS user_id, blob7 AS ip, blob8 AS ua,
				       blob9 AS country, blob10 AS colo, blob11 AS ray_id,
				       blob12 AS action, blob13 AS module, blob14 AS error, blob15 AS body
				FROM ${AE_DATASET}
				WHERE timestamp >= toDateTime('${dateStr} 00:00:00')
				  AND timestamp <= toDateTime('${dateStr} 23:59:59')
				ORDER BY time ASC
				LIMIT 200000
			`;
			const data = await this.aeQuery(env, sql);
			const rows = data.data || [];
			if (rows.length) {
				const lines = rows.map(r => JSON.stringify(r)).join('\n');
				await env.r2.put(`${LOG_ARCHIVE_PREFIX}${dateStr}/requests.jsonl`, lines, {
					httpMetadata: { contentType: 'application/x-ndjson' }
				});
				console.log(`archived requests: ${dateStr}, ${rows.length} rows`);
			}
		} catch (e) {
			console.error('archive requests failed:', e.message);
		}
	},

	async cleanup(env) {
		// 读取配置：log_audit_days = 0 表示永久保留
		const row = await env.db.prepare(`SELECT log_audit_days FROM setting LIMIT 1`).first();
		const days = Number(row?.log_audit_days ?? 0);

		if (days > 0) {
			// 与 clearAudit 同理：created_at 是 ISO 格式，必须用 strftime 对齐格式
			const res = await env.db.prepare(`
				DELETE FROM audit_log WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
			`).bind(`-${days} days`).run();
			console.log(`cleaned audit_log: ${res.meta?.changes ?? 0} rows (retention ${days} days)`);
		}
	}
};

export default logService;
