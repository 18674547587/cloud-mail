import app from '../hono/hono';
import userService from '../service/user-service';
import result from '../model/result';
import userContext from '../security/user-context';
import captchaProviderService from '../service/captcha-provider-service';
import orm from '../entity/orm';
import user from '../entity/user';
import { eq } from 'drizzle-orm';
import BizError from '../error/biz-error';
import { isValidPreference } from '../utils/captcha-utils';
import { t } from '../i18n/i18n';

app.get('/my/loginUserInfo', async (c) => {
	const user = await userService.loginUserInfo(c, userContext.getUserId(c));
	return c.json(result.ok(user));
});

app.put('/my/resetPassword', async (c) => {
	await userService.resetPassword(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.delete('/my/delete', async (c) => {
	await userService.delete(c, userContext.getUserId(c));
	return c.json(result.ok());
});

// 当前用户的人机验证渲染配置（provider 由服务端决策，前端不自行判断）
app.get('/my/captchaConfig', async (c) => {
	const data = await captchaProviderService.configFor(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});

// 保存用户的人机验证偏好：0 = 跟随默认，1 = Turnstile，2 = hCaptcha
app.put('/my/captchaProvider', async (c) => {
	const params = await c.req.json();
	const provider = Number(params.captchaProvider);

	if (!isValidPreference(provider)) {
		throw new BizError(t('captchaProviderInvalid'), 400);
	}

	await orm(c).update(user)
		.set({ captchaProvider: provider })
		.where(eq(user.userId, userContext.getUserId(c)))
		.run();

	return c.json(result.ok());
});


