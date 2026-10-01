import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * 审计日志表：只记录关键操作（登录、改密、发信、设置修改、增删改等）
 * 明细（全量请求）不落这里，落 Analytics Engine
 */
export const auditLog = sqliteTable('audit_log', {
	logId: integer('log_id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id'),
	userEmail: text('user_email'),
	action: text('action'),
	module: text('module'),
	method: text('method'),
	path: text('path'),
	status: integer('status'),
	duration: integer('duration'),
	ip: text('ip'),
	ua: text('ua'),
	country: text('country'),
	rayId: text('ray_id'),
	target: text('target'),
	detail: text('detail'),
	error: text('error'),
	createdAt: text('created_at')
});

export default auditLog;
