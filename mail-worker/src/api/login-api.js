import app from '../hono/hono';
import loginService from '../service/login-service';
import result from '../model/result';
import userContext from '../security/user-context';
import turnstileService from '../service/turnstile-service';
import settingService from '../service/setting-service';
import { t } from '../i18n/i18n';

app.post('/login', async (c) => {
	const params = await c.req.json();
	const settingRow = await settingService.query(c);
	if (settingRow.siteKey) {
		if (!params.token) {
			return c.json(result.fail(t('emptyBotToken'), 400));
		}
		await turnstileService.verify(c, params.token);
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

app.post('/register', async (c) => {
	const jwt = await loginService.register(c, await c.req.json());
	return c.json(result.ok(jwt));
});

app.delete('/logout', async (c) => {
	await loginService.logout(c, userContext.getUserId(c));
	return c.json(result.ok());
});
