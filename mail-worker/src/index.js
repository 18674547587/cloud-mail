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

		// 客户端自动配置（Thunderbird autoconfig / Outlook autodiscover）
		if (url.pathname === '/mail/config-v1.1.xml' || url.pathname === '/autodiscover/autodiscover.xml') {
			return handleAutoConfig(url);
		}

		// 邮件实时推送的 WebSocket 入口
		// 必须在 hono 之前拦截：WebSocket 无法携带自定义请求头，token 只能走 URL 参数
		if (url.pathname === '/api/push/ws') {
			return handlePushWebSocket(req, env, url);
		}

		if (url.pathname.startsWith('/api/')) {

			// 兼容层（2026-10-10）：旧版 Android App 的 baseUrl 已含 /api，
			// 而 Retrofit 接口注解又写成 "api/xxx"，两者拼接会得到 /api/api/xxx。
			// 这里剥掉重复的一层，避免为了修一个前缀就必须重新打包 APK。
			// 注意：只影响以 /api/api/ 开头的路径，正常请求不受任何影响。
			if (url.pathname.startsWith('/api/api/')) {
				url.pathname = url.pathname.substring(4)
			}

			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req);
			return app.fetch(req, env, ctx);
		}

		 if (['/static/','/attachments/','/avatar/'].some(p => url.pathname.startsWith(p))) {
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
 * 客户端自动配置
 * - Thunderbird: https://autoconfig.<domain>/mail/config-v1.1.xml
 * - Outlook:     https://autodiscover.<domain>/autodiscover/autodiscover.xml
 * 所有域名共用同一组服务器地址（imap/smtp.1206201.xyz）。
 */
function handleAutoConfig(url) {

	const domain = (url.hostname || '').replace(/^autoconfig\./i, '').replace(/^autodiscover\./i, '');
	const IMAP = 'imap.1206201.xyz';
	const SMTP = 'smtp.1206201.xyz';

	if (url.pathname === '/mail/config-v1.1.xml') {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${domain}">
    <domain>${domain}</domain>
    <displayName>${domain} Mail</displayName>
    <displayShortName>${domain}</displayShortName>
    <incomingServer type="imap">
      <hostname>${IMAP}</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>${SMTP}</hostname>
      <port>465</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;
		return new Response(xml, {
			headers: { 'Content-Type': 'application/xml; charset=UTF-8', 'Cache-Control': 'public, max-age=3600' }
		});
	}

	const xml = `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>${IMAP}</Server>
        <Port>993</Port>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <SSL>on</SSL>
        <AuthRequired>on</AuthRequired>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>${SMTP}</Server>
        <Port>465</Port>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <SSL>on</SSL>
        <AuthRequired>on</AuthRequired>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>`;

	return new Response(xml, {
		headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
	});
}

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
