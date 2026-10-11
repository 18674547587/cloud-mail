import app from '../hono/hono';
import userService from '../service/user-service';
import avatarService from '../service/avatar-service';
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

// ===================== 头像（用户级，本人操作） =====================

// 申请头像直传凭证：返回 { key, uploadUrl, headers }，前端拿到后直接 PUT 到对象存储
app.post('/my/avatar/presign', async (c) => {
	const data = await avatarService.presign(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

// 上传完成后确认保存（key 归属当前登录用户）
app.put('/my/avatar', async (c) => {
	const userId = userContext.getUserId(c);
	const data = await avatarService.save(c, await c.req.json(), userId, userId);
	return c.json(result.ok(data));
});

// 清除头像，恢复默认文字头像
app.delete('/my/avatar', async (c) => {
	const data = await avatarService.remove(c, userContext.getUserId(c));
	return c.json(result.ok(data));
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


