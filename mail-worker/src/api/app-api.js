/**
 * 设备令牌管理接口（需 JWT 鉴权）
 *
 * 这些接口供「网页端」或「已登录的 App」调用，用于创建/查看/吊销设备令牌。
 * 注意：/app/* 不在 security.js 的 exclude 白名单中，因此会正常走 JWT 校验。
 */
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import appTokenService from '../service/app-token-service';

// 创建新的设备令牌（明文只返回一次）
app.post('/app/token', async (c) => {
	const data = await appTokenService.create(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

// 查看已授权的设备列表
app.get('/app/token/list', async (c) => {
	const list = await appTokenService.list(c, userContext.getUserId(c));
	return c.json(result.ok(list));
});

// 吊销设备令牌
app.delete('/app/token/revoke', async (c) => {
	await appTokenService.revoke(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok());
});

export default app;
