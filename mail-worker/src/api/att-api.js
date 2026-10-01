import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import attService from '../service/att-service';

// 申请附件直传凭证（前端拿到 uploadUrl 后直接 PUT 到对象存储）
app.post('/att/presign', async (c) => {
	const data = await attService.presign(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(data));
});
