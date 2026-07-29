import BizError from '../error/biz-error';
import settingService from './setting-service';
import { t } from '../i18n/i18n'

const turnstileService = {

	async verify(c, token, options = {}) {

		if (!token) {
			throw new BizError(t('emptyBotToken'), 400);
		}

		const settingRow = await settingService.query(c);

		if (!settingRow.secretKey) {
			console.warn('[Turnstile] secretKey 未配置，跳过验证');
			return;
		}

		const remoteIp = c.req.header('cf-connecting-ip') ||
		                 c.req.header('x-forwarded-for') ||
		                 '';

		const startTime = Date.now();

		const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({
				secret: settingRow.secretKey,
				response: token,
				remoteip: remoteIp
			})
		});

		const result = await res.json();
		const elapsed = Date.now() - startTime;

		if (!result.success) {
			const errorCodes = result['error-codes'] || [];
			const action = options.action || 'unknown';

			console.warn(
				`[Turnstile] 验证失败 | 操作: ${action} | ` +
				`耗时: ${elapsed}ms | ` +
				`错误码: ${errorCodes.join(', ') || '无'}`
			);

			if (errorCodes.includes('timeout-or-duplicate')) {
				throw new BizError(t('botVerifyFail'), 400);
			} else if (errorCodes.includes('invalid-input-secret')) {
				console.error('[Turnstile] secretKey 配置错误，请在系统设置中检查');
				throw new BizError(t('botVerifyFail'), 400);
			} else if (errorCodes.includes('invalid-input-response')) {
				throw new BizError(t('emptyBotToken'), 400);
			} else if (errorCodes.includes('internal-error')) {
				throw new BizError(t('botVerifyFail'), 400);
			}

			throw new BizError(t('botVerifyFail'), 400);
		}

		if (result.hostname) {
			console.log(
				`[Turnstile] 验证成功 | 操作: ${options.action || 'unknown'} | ` +
				`耗时: ${elapsed}ms | hostname: ${result.hostname}`
			);
		}
	}
};

export default turnstileService;
