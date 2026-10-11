import BizError from '../error/biz-error';
import settingService from './setting-service';
import { t } from '../i18n/i18n';
import { captchaConst } from '../const/entity-const';
import { secretOf, siteKeyOf } from '../utils/captcha-utils';

/**
 * 统一人机验证服务（Turnstile / hCaptcha）
 *
 * 两家校验接口的请求/响应格式基本一致：
 *   POST <endpoint>  secret=xxx&response=token&remoteip=xxx
 *   => { success: boolean, 'error-codes': [], hostname?: string }
 *
 * 差异：端点不同、secret/siteKey 取自 setting 表的不同字段。
 */

const ENDPOINTS = {
	[captchaConst.provider.TURNSTILE]: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
	[captchaConst.provider.HCAPTCHA]: 'https://api.hcaptcha.com/siteverify'
};

const PROVIDER_NAME = {
	[captchaConst.provider.TURNSTILE]: 'Turnstile',
	[captchaConst.provider.HCAPTCHA]: 'hCaptcha'
};

// 服务端配置类错误码（与访客无关，属运维问题）
const SECRET_ERROR_CODES = ['missing-input-secret', 'invalid-input-secret', 'sitekey-secret-mismatch'];

const captchaService = {

	providerName(provider) {
		return PROVIDER_NAME[provider] || `unknown(${provider})`;
	},

	isSupported(provider) {
		return provider === captchaConst.provider.TURNSTILE || provider === captchaConst.provider.HCAPTCHA;
	},

	/** 取指定 provider 的校验密钥（未配置返回空串） */
	secretOf(settingRow, provider) {
		return secretOf(settingRow, provider);
	},

	/** 取指定 provider 的公开 site key */
	siteKeyOf(settingRow, provider) {
		return siteKeyOf(settingRow, provider);
	},

	/**
	 * 校验访客令牌
	 * @param {*} c hono context
	 * @param {string} token 前端 widget 回调拿到的 token
	 * @param {{provider?: number, action?: string}} options
	 */
	async verify(c, token, options = {}) {

		const provider = options.provider ?? captchaConst.provider.TURNSTILE;
		const name = this.providerName(provider);

		if (!token) {
			throw new BizError(t('emptyBotToken'), 400);
		}

		if (!this.isSupported(provider)) {
			console.error(`[Captcha] 未知的 provider: ${provider}`);
			throw new BizError(t('botVerifyFail'), 400);
		}

		const settingRow = await settingService.query(c);
		const secret = this.secretOf(settingRow, provider);

		// 与既有行为保持一致：未配置密钥则跳过校验（便于渐进启用）
		if (!secret) {
			console.warn(`[Captcha] ${name} secretKey 未配置，跳过验证`);
			return;
		}

		const remoteIp = c.req.header('cf-connecting-ip') ||
		                 c.req.header('x-forwarded-for') ||
		                 '';

		const startTime = Date.now();

		let res;
		try {
			res = await fetch(ENDPOINTS[provider], {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded'
				},
				body: new URLSearchParams({
					secret: secret,
					response: token,
					remoteip: remoteIp
				})
			});
		} catch (e) {
			console.error(`[Captcha] ${name} 校验请求异常: ${e.message}`);
			throw new BizError(t('botVerifyFail'), 400);
		}

		let result;
		try {
			result = await res.json();
		} catch (e) {
			console.error(`[Captcha] ${name} 返回内容无法解析`);
			throw new BizError(t('botVerifyFail'), 400);
		}

		const elapsed = Date.now() - startTime;

		if (!result.success) {
			const errorCodes = result['error-codes'] || [];
			const action = options.action || 'unknown';

			console.warn(
				`[Captcha] ${name} 验证失败 | 操作: ${action} | ` +
				`耗时: ${elapsed}ms | ` +
				`错误码: ${errorCodes.join(', ') || '无'}`
			);

			if (errorCodes.some(code => SECRET_ERROR_CODES.includes(code))) {
				console.error(`[Captcha] ${name} 密钥配置错误，请在系统设置中检查`);
				throw new BizError(t('botVerifyFail'), 400);
			}

			if (errorCodes.some(code => code === 'invalid-input-response' || code === 'missing-input-response')) {
				throw new BizError(t('emptyBotToken'), 400);
			}

			throw new BizError(t('botVerifyFail'), 400);
		}

		console.log(
			`[Captcha] ${name} 验证成功 | 操作: ${options.action || 'unknown'} | ` +
			`耗时: ${elapsed}ms` +
			(result.hostname ? ` | hostname: ${result.hostname}` : '')
		);
	}
};

export default captchaService;
