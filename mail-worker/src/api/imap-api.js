import app from '../hono/hono';
import result from '../model/result';
import emailService from '../service/email-service';

/**
 * Stalwart → 云邮 的状态回写入口
 *
 * 由 VPS 上的轮询脚本调用（/opt/imap-state-sync/sync.py），
 * 用 X-Api-Secret（= env.jwt_secret）鉴权。
 *
 * security.js 已把 '/imap' 加入 exclude，因此这里必须自行完成鉴权。
 */
app.post('/imap/state', async (c) => {

	const secret = c.req.header('X-Api-Secret');

	if (!c.env.jwt_secret || !secret || secret !== c.env.jwt_secret) {
		return c.json(result.fail('API 密钥错误', 401));
	}

	const params = await c.req.json();

	await emailService.applyImapState(c, params);

	return c.json(result.ok());
});
