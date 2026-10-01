import app from './hono/webs';
import { email } from './email/email';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import r2Service from './service/r2-service';
import attService from './service/att-service';
import oauthService from "./service/oauth-service";
import jwtUtils from './utils/jwt-utils';
import KvConst from './const/kv-const';
import logService from './log/log-service';

// Durable Object：邮件实时推送
export { MailPush } from './durable/mail-push';

export default {
	 async fetch(req, env, ctx) {

		const url = new URL(req.url)

		// 邮件实时推送的 WebSocket 入口
		// 必须在 hono 之前拦截：WebSocket 无法携带自定义请求头，token 只能走 URL 参数
		if (url.pathname === '/api/push/ws') {
			return handlePushWebSocket(req, env, url);
		}

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			return app.fetch(req, env, ctx);
		}

		 if (['/static/','/attachments/'].some(p => url.pathname.startsWith(p))) {
			 return await r2Service.toObjResp({ env }, url.pathname.substring(1));
		 }

		return env.assets.fetch(req);
	},
	email: email,
	async scheduled(c, env, ctx) {
		await verifyRecordService.clearRecord({ env })
		await userService.resetDaySendCount({ env })
		await emailService.completeReceiveAll({ env })
		await oauthService.clearNoBindOathUser({ env })
		await attService.clearOrphan({ env })
		// 日志：每日聚合 + R2 归档 + 过期清理
		await logService.dailyJob(env, c)
	},
};

/**
 * 处理邮件实时推送的 WebSocket 连接
 *
 * 鉴权说明：WebSocket API 无法自定义请求头，因此 token 通过 URL 参数传入。
 * 这里复用与 security.js 完全一致的校验逻辑：
 *   1. 验签 JWT（依赖 env.jwt_secret）
 *   2. 校验 token 是否仍在 KV 中的登录会话里（支持多端登录、可被踢下线）
 *
 * @returns {Promise<Response>}
 */
async function handlePushWebSocket(req, env, url) {

	const token = url.searchParams.get('token');

	if (!token) {
		return new Response('missing token', { status: 401 });
	}

	// 1) 验签 JWT（jwtUtils 内部只用到 c.env.jwt_secret）
	const payload = await jwtUtils.verifyToken({ env }, token);

	if (!payload || !payload.userId) {
		return new Response('invalid token', { status: 401 });
	}

	// 2) 校验登录会话是否仍然有效
	const authInfo = await env.kv.get(KvConst.AUTH_INFO + payload.userId, { type: 'json' });

	if (!authInfo || !Array.isArray(authInfo.tokens) || !authInfo.tokens.includes(payload.token)) {
		return new Response('auth expired', { status: 401 });
	}

	// 3) 转发给该用户对应的 Durable Object（按 userId 分实例）
	const id = env.MAIL_PUSH.idFromName('u-' + payload.userId);

	return env.MAIL_PUSH.get(id).fetch(req);
}
