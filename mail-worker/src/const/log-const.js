/**
 * 日志系统常量
 *
 * 设计说明：
 *  - 请求明细（全量）写入 Analytics Engine 数据集，保留期由 AE 决定（3 个月）
 *  - 关键操作审计写入 D1 表 audit_log，保留期可配置（0 = 永久）
 *  - 每日聚合写入 D1 表 log_stat_daily，永久保留
 */

// AE 数据集名（与 wrangler.toml 中 analytics_engine_datasets.dataset 保持一致）
export const AE_DATASET = 'cloudmail_logs';

// 审计动作类型
export const LOG_ACTION = {
	LOGIN: 'login',
	LOGOUT: 'logout',
	REGISTER: 'register',
	RESET_PASSWORD: 'reset-password',
	DELETE_ACCOUNT: 'delete-account',
	SEND_EMAIL: 'send-email',
	DELETE_EMAIL: 'delete-email',
	ADD_ACCOUNT: 'add-account',
	REMOVE_ACCOUNT: 'remove-account',
	ADD_USER: 'add-user',
	DELETE_USER: 'delete-user',
	SET_USER_PASSWORD: 'set-user-password',
	SET_USER_STATUS: 'set-user-status',
	SET_USER_ROLE: 'set-user-role',
	RESET_SEND_COUNT: 'reset-send-count',
	ADD_ROLE: 'add-role',
	SET_ROLE: 'set-role',
	DELETE_ROLE: 'delete-role',
	SET_SETTING: 'set-setting',
	SET_BACKGROUND: 'set-background',
	DELETE_BACKGROUND: 'delete-background',
	ADD_REG_KEY: 'add-reg-key',
	DELETE_REG_KEY: 'delete-reg-key',
	CLEAR_REG_KEY: 'clear-reg-key',
	DELETE_ALL_EMAIL: 'delete-all-email',
	BATCH_DELETE_EMAIL: 'batch-delete-email',
	RESEND_WEBHOOK: 'resend-webhook',
	OAUTH: 'oauth',
	PUBLIC_API: 'public-api',
	CLEAR_LOG: 'clear-log',
	EXPORT_LOG: 'export-log',
	SET_LOG_CONFIG: 'set-log-config',
	ERROR: 'error'
};

// 审计模块
export const LOG_MODULE = {
	AUTH: 'auth',
	EMAIL: 'email',
	ACCOUNT: 'account',
	USER: 'user',
	ROLE: 'role',
	SETTING: 'setting',
	REG_KEY: 'reg-key',
	ALL_EMAIL: 'all-email',
	WEBHOOK: 'webhook',
	OAUTH: 'oauth',
	PUBLIC: 'public',
	LOG: 'log',
	SYSTEM: 'system'
};

/**
 * 审计触发规则：命中即写入 D1 审计表
 * 注意：按 prefix 长度降序匹配，避免 '/setting/set' 误匹配 '/setting/setBackground'
 */
export const AUDIT_RULES = [
	{ prefix: '/setting/setBackground', action: LOG_ACTION.SET_BACKGROUND, module: LOG_MODULE.SETTING },
	{ prefix: '/setting/deleteBackground', action: LOG_ACTION.DELETE_BACKGROUND, module: LOG_MODULE.SETTING },
	{ prefix: '/setting/set', action: LOG_ACTION.SET_SETTING, module: LOG_MODULE.SETTING },

	{ prefix: '/my/resetPassword', action: LOG_ACTION.RESET_PASSWORD, module: LOG_MODULE.USER },
	{ prefix: '/my/delete', action: LOG_ACTION.DELETE_ACCOUNT, module: LOG_MODULE.USER },

	{ prefix: '/user/resetSendCount', action: LOG_ACTION.RESET_SEND_COUNT, module: LOG_MODULE.USER },
	{ prefix: '/user/setPwd', action: LOG_ACTION.SET_USER_PASSWORD, module: LOG_MODULE.USER },
	{ prefix: '/user/setStatus', action: LOG_ACTION.SET_USER_STATUS, module: LOG_MODULE.USER },
	{ prefix: '/user/setType', action: LOG_ACTION.SET_USER_ROLE, module: LOG_MODULE.USER },
	{ prefix: '/user/deleteAccount', action: LOG_ACTION.REMOVE_ACCOUNT, module: LOG_MODULE.USER },
	{ prefix: '/user/delete', action: LOG_ACTION.DELETE_USER, module: LOG_MODULE.USER },
	{ prefix: '/user/add', action: LOG_ACTION.ADD_USER, module: LOG_MODULE.USER },

	{ prefix: '/role/setDefault', action: LOG_ACTION.SET_ROLE, module: LOG_MODULE.ROLE },
	{ prefix: '/role/set', action: LOG_ACTION.SET_ROLE, module: LOG_MODULE.ROLE },
	{ prefix: '/role/delete', action: LOG_ACTION.DELETE_ROLE, module: LOG_MODULE.ROLE },
	{ prefix: '/role/add', action: LOG_ACTION.ADD_ROLE, module: LOG_MODULE.ROLE },

	{ prefix: '/regKey/clearNotUse', action: LOG_ACTION.CLEAR_REG_KEY, module: LOG_MODULE.REG_KEY },
	{ prefix: '/regKey/delete', action: LOG_ACTION.DELETE_REG_KEY, module: LOG_MODULE.REG_KEY },
	{ prefix: '/regKey/add', action: LOG_ACTION.ADD_REG_KEY, module: LOG_MODULE.REG_KEY },

	{ prefix: '/allEmail/batchDelete', action: LOG_ACTION.BATCH_DELETE_EMAIL, module: LOG_MODULE.ALL_EMAIL },
	{ prefix: '/allEmail/delete', action: LOG_ACTION.DELETE_ALL_EMAIL, module: LOG_MODULE.ALL_EMAIL },

	{ prefix: '/email/send', action: LOG_ACTION.SEND_EMAIL, module: LOG_MODULE.EMAIL },
	{ prefix: '/email/delete', action: LOG_ACTION.DELETE_EMAIL, module: LOG_MODULE.EMAIL },

	{ prefix: '/account/add', action: LOG_ACTION.ADD_ACCOUNT, module: LOG_MODULE.ACCOUNT },
	{ prefix: '/account/delete', action: LOG_ACTION.REMOVE_ACCOUNT, module: LOG_MODULE.ACCOUNT },

	{ prefix: '/login', action: LOG_ACTION.LOGIN, module: LOG_MODULE.AUTH },
	{ prefix: '/logout', action: LOG_ACTION.LOGOUT, module: LOG_MODULE.AUTH },
	{ prefix: '/register', action: LOG_ACTION.REGISTER, module: LOG_MODULE.AUTH },

	{ prefix: '/webhooks', action: LOG_ACTION.RESEND_WEBHOOK, module: LOG_MODULE.WEBHOOK },
	{ prefix: '/oauth', action: LOG_ACTION.OAUTH, module: LOG_MODULE.OAUTH },
	{ prefix: '/public', action: LOG_ACTION.PUBLIC_API, module: LOG_MODULE.PUBLIC },

	// 注意：实际路由是 /log/audit/clear 与 /log/audit/export，
	// 历史版本写成 /log/clear 导致「清空审计日志」这个高危动作从未被记录，已修正。
	{ prefix: '/log/audit/clear', action: LOG_ACTION.CLEAR_LOG, module: LOG_MODULE.LOG },
	{ prefix: '/log/audit/export', action: LOG_ACTION.EXPORT_LOG, module: LOG_MODULE.LOG },
	// 只有 PUT 才算「改配置」，GET /log/config 只是读取，不应记为 set-log-config
	{ prefix: '/log/config', method: 'PUT', action: LOG_ACTION.SET_LOG_CONFIG, module: LOG_MODULE.LOG }
];

// 日志默认配置（setting 表字段缺失时的兜底值）
export const LOG_DEFAULT_CONFIG = {
	logEnabled: 1,
	logAuditEnabled: 1,
	logReqDays: 30,
	logAuditDays: 0,
	logArchive: 1
};

// 明细单条字段截断长度（单位：UTF-8 字节，不是字符数）
// Analytics Engine 限制：单个数据点所有 blob 合计不超过 16 KB。
// 这里合计约 400+2000+6000+300 = 8700 字节，留足余量。
// 历史版本按 String.length（UTF-16 字符数）截断，中文场景下会突破 16 KB 导致整条日志被丢弃。
export const LOG_LIMIT = {
	UA: 400,
	ERROR: 2000,
	BODY: 6000,
	REFERER: 300
};

// 明细查询单页最大条数
export const LOG_PAGE_MAX = 100;

// 每天定时任务归档到 R2 的前缀
export const LOG_ARCHIVE_PREFIX = 'log-archive/';

/**
 * 命中审计规则
 * @param {string} path 请求路径
 * @param {string} [method] 请求方法，用于区分同路径的读写（如 GET/PUT /log/config）
 * @returns {{action: string, module: string}|null}
 */
export function matchAuditRule(path, method) {
	const m = method ? String(method).toUpperCase() : '';
	let matched = null;
	for (const rule of AUDIT_RULES) {
		if (rule.method && m && rule.method !== m) {
			continue;
		}
		if (path.startsWith(rule.prefix)) {
			if (!matched || rule.prefix.length > matched.prefix.length) {
				matched = rule;
			}
		}
	}
	return matched ? { action: matched.action, module: matched.module } : null;
}

export default {
	AE_DATASET,
	LOG_ACTION,
	LOG_MODULE,
	AUDIT_RULES,
	LOG_DEFAULT_CONFIG,
	LOG_LIMIT,
	LOG_PAGE_MAX,
	LOG_ARCHIVE_PREFIX,
	matchAuditRule
};
