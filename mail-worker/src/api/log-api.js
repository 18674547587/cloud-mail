import app from '../hono/hono';
import result from '../model/result';
import logService from '../log/log-service';
import settingService from '../service/setting-service';
import permService from '../service/perm-service';

/* ============================ 配置 ============================ */

app.get('/log/config', async (c) => {
	const config = await logService.config(c);
	return c.json(result.ok(config));
});

app.put('/log/config', async (c) => {
	// 修改日志配置属于高危操作（可以关闭审计、关掉归档），
	// 因此要求比「查看日志」（log:query）更高的权限。
	// 说明：GET 与 PUT 同路径，security.js 的 requirePerms 无法按方法区分，
	// 所以这里在处理器内补一道校验。
	const user = c.get('user');
	if (!user || user.email !== c.env.admin) {
		const permKeys = await permService.userPermKeys(c, user?.userId);
		if (!Array.isArray(permKeys) || !permKeys.includes('log:delete')) {
			return c.json(result.fail('无权修改日志配置（需要 log:delete 权限）', 403));
		}
	}

	const body = await c.req.json();
	await logService.setConfig(c, body);
	return c.json(result.ok(await logService.config(c)));
});

/* ============================ 明细（AE） ============================ */

app.get('/log/req/list', async (c) => {
	const list = await logService.reqList(c, c.req.query());
	return c.json(result.ok(list));
});

app.get('/log/req/overview', async (c) => {
	const data = await logService.reqOverview(c, c.req.query());
	return c.json(result.ok(data));
});

app.get('/log/req/topPaths', async (c) => {
	const data = await logService.reqTopPaths(c, c.req.query());
	return c.json(result.ok(data));
});

/* ============================ 审计（D1） ============================ */

app.get('/log/audit/list', async (c) => {
	const data = await logService.auditList(c, c.req.query());
	return c.json(result.ok(data));
});

app.get('/log/audit/detail', async (c) => {
	const { logId } = c.req.query();
	if (!logId) {
		return c.json(result.fail('缺少 logId', 400));
	}
	const data = await logService.auditDetail(c, logId);
	return c.json(result.ok(data));
});

app.get('/log/audit/export', async (c) => {
	const rows = await logService.auditExport(c, c.req.query());

	const headers = ['log_id', 'created_at', 'user_id', 'user_email', 'action', 'module', 'method', 'path',
		'status', 'duration', 'ip', 'country', 'ray_id', 'target', 'detail', 'error'];

	const escapeCsv = (v) => {
		if (v === null || v === undefined) return '';
		const s = String(v).replace(/"/g, '""').replace(/\r?\n/g, ' ');
		return `"${s}"`;
	};

	const lines = [headers.join(',')];
	for (const row of rows) {
		lines.push(headers.map(h => escapeCsv(row[h])).join(','));
	}

	// 加 BOM，避免 Excel 打开中文乱码
	const csv = '\uFEFF' + lines.join('\r\n');

	return new Response(csv, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="audit-log-${Date.now()}.csv"`
		}
	});
});

app.delete('/log/audit/clear', async (c) => {
	const changes = await logService.clearAudit(c, c.req.query());
	return c.json(result.ok({ changes }));
});

/* ============================ 统计 ============================ */

app.get('/log/stat/list', async (c) => {
	const data = await logService.statList(c, c.req.query());
	return c.json(result.ok(data));
});

app.get('/log/stat/pathList', async (c) => {
	const data = await logService.statPathList(c, c.req.query());
	return c.json(result.ok(data));
});
