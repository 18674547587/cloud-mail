import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * 每日聚合统计表
 * AE 明细只保留 3 个月，这里把趋势长期留在 D1（永久）
 */
export const logStatDaily = sqliteTable('log_stat_daily', {
	statId: integer('stat_id').primaryKey({ autoIncrement: true }),
	statDate: text('stat_date'),
	path: text('path'),
	method: text('method'),
	statusGroup: text('status_group'),
	total: integer('total'),
	errors: integer('errors'),
	avgDuration: integer('avg_duration'),
	maxDuration: integer('max_duration'),
	createdAt: text('created_at')
});

export default logStatDaily;
