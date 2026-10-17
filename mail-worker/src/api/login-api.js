import app from '../hono/hono';
import loginService from '../service/login-service';
import result from '../model/result';
import userContext from '../security/user-context';
import captchaProviderService from '../service/captcha-provider-service';
import BizError from '../error/biz-error';
import appTokenService from '../service/app-token-service';
import settingService from '../service/setting-service';
import { t } from '../i18n/i18n';

app.post('/login', async (c) => {
	const params = await c.req.json();
	// 人机验证：未登录场景按「全局强制 → 访客 IP 归属」选择 provider（中国大陆 → hCaptcha）
	if (await captchaProviderService.needVerify(c)) {
		if (!params.token) {
			return c.json(result.fail(t('emptyBotToken'), 400));
		}
		await captchaProviderService.verify(c, params.token, { action: 'login' });
	}
	const token = await loginService.login(c, params);
	return c.json(result.ok({ token: token }));
});

// 供脚本 / 自动化调用：用环境变量 jwt_secret 替代人机验证
// 调用方式：POST /api/login/api  Header: X-Api-Secret: <jwt_secret>
//           body: {"email":"xxx@yyy","password":"..."}
app.post('/login/api', async (c) => {

	const params = await c.req.json();
	const secret = c.req.header('X-Api-Secret') || params.apiSecret;

	if (!c.env.jwt_secret || !secret || secret !== c.env.jwt_secret) {
		return c.json(result.fail(t('apiSecretFail'), 401));
	}

	const token = await loginService.login(c, params);
	return c.json(result.ok({ token: token }));
});

// 供本地 SMTP 网关使用：凭 apiSecret 免密签发指定账号的 JWT。
// 场景：客户端通过 IMAP 出口服务器（Stalwart）提交邮件，网关解析后需以「发件人本人」的
//       身份调用 /api/email/send，才能保留发件箱记录、发送限额与退信链路。
// 安全：与 /login/api 同级 —— 仅在 X-Api-Secret 等于 jwt_secret 时放行。
app.post('/login/api/impersonate', async (c) => {

	const params = await c.req.json();
	const secret = c.req.header('X-Api-Secret') || params.apiSecret;

	if (!c.env.jwt_secret || !secret || secret !== c.env.jwt_secret) {
		return c.json(result.fail(t('apiSecretFail'), 401));
	}

	if (!params.email) {
		return c.json(result.fail(t('emailAndPwdEmpty'), 400));
	}

	const token = await loginService.login(c, { email: params.email }, true);
	return c.json(result.ok({ token: token }));
});

// 设备令牌登录：供安卓客户端使用
// 说明：路径以 /login 开头，会被 security.js 的 exclude 白名单前缀匹配放行，
//       因此这里必须自行完成设备令牌校验，不能依赖外层鉴权。
app.post('/login/app', async (c) => {

	const params = await c.req.json();
	const { email, deviceToken } = params;

	if (!email || !deviceToken) {
		throw new BizError('邮箱与设备令牌不能为空');
	}

	// 1) 校验设备令牌（内部含失败限流），返回 userId 与规范化邮箱
	const { email: userEmail } = await appTokenService.verifyAndGetUserId(c, params);

	// 2) 复用标准登录流程签发 JWT（noVerifyPwd = true，密码校验已由设备令牌替代）
	//    这一步会同时写入 KV 会话记录，因此多端登录 / 踢下线机制完全一致
	const token = await loginService.login(c, { email: userEmail }, true);

	return c.json(result.ok({ token: token }));
});

app.post('/register', async (c) => {
	const jwt = await loginService.register(c, await c.req.json());
	return c.json(result.ok(jwt));
});

app.delete('/logout', async (c) => {
	await loginService.logout(c, userContext.getUserId(c));
	return c.json(result.ok());
});
