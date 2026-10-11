import { captchaConst } from '../const/entity-const';

/**
 * 人机验证相关的纯逻辑（不依赖任何 service，避免循环导入，便于单测）
 */

/** setting 表中各 provider 对应的字段名 */
export const CAPTCHA_FIELDS = {
	[captchaConst.provider.TURNSTILE]: { siteKey: 'siteKey', secretKey: 'secretKey' },
	[captchaConst.provider.HCAPTCHA]: { siteKey: 'hcaptchaSiteKey', secretKey: 'hcaptchaSecretKey' }
};

/** 取访客国家码（Cloudflare 边缘注入；本地 dev / 非 CF 环境可能为空） */
export function countryOf(c) {
	try {
		return c?.req?.raw?.cf?.country || '';
	} catch (e) {
		return '';
	}
}

/**
 * 决策：本次请求用哪家人机验证
 *   1. 全局强制（≠ AUTO）优先
 *   2. 用户偏好（≠ AUTO）
 *   3. 按 IP：中国大陆（CN）→ hCaptcha，其余（含港澳台）→ Turnstile
 *
 * @param {{globalProvider?: number, userProvider?: number, country?: string}} input
 * @returns {number} captchaConst.provider.*
 */
export function decideProvider({ globalProvider = 0, userProvider = 0, country = '' } = {}) {

	if (globalProvider === captchaConst.provider.TURNSTILE || globalProvider === captchaConst.provider.HCAPTCHA) {
		return globalProvider;
	}

	if (userProvider === captchaConst.provider.TURNSTILE || userProvider === captchaConst.provider.HCAPTCHA) {
		return userProvider;
	}

	return country === captchaConst.country.CN
		? captchaConst.provider.HCAPTCHA
		: captchaConst.provider.TURNSTILE;
}

/** 取指定 provider 的公开 site key */
export function siteKeyOf(settingRow, provider) {
	const field = CAPTCHA_FIELDS[provider]?.siteKey;
	return (field && settingRow?.[field]) || '';
}

/** 取指定 provider 的校验密钥 */
export function secretOf(settingRow, provider) {
	const field = CAPTCHA_FIELDS[provider]?.secretKey;
	return (field && settingRow?.[field]) || '';
}

/** 指定 provider 是否已完整配置 */
export function isConfigured(settingRow, provider) {
	return !!siteKeyOf(settingRow, provider) && !!secretOf(settingRow, provider);
}

/** 另一家 provider */
export function otherProvider(provider) {
	return provider === captchaConst.provider.HCAPTCHA
		? captchaConst.provider.TURNSTILE
		: captchaConst.provider.HCAPTCHA;
}

/**
 * 首选 provider 未配置时回退到另一家；两家都没配置则返回首选
 * （前后端必须用同一套回退逻辑，否则会出现「后端要求验证、前端不渲染」的死锁）
 */
export function pickUsableProvider(settingRow, provider) {
	if (isConfigured(settingRow, provider)) {
		return provider;
	}
	const other = otherProvider(provider);
	return isConfigured(settingRow, other) ? other : provider;
}

/** 校验用户偏好取值是否合法 */
export function isValidPreference(value) {
	return value === captchaConst.provider.AUTO ||
		value === captchaConst.provider.TURNSTILE ||
		value === captchaConst.provider.HCAPTCHA;
}
