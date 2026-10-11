import settingService from './setting-service';
import captchaService from './captcha-service';
import orm from '../entity/orm';
import user from '../entity/user';
import { eq } from 'drizzle-orm';
import { captchaConst } from '../const/entity-const';
import { countryOf, decideProvider, pickUsableProvider } from '../utils/captcha-utils';

/**
 * 决定「本次请求该用哪家人机验证」——服务端为唯一权威，不信任前端传入。
 *
 * 优先级：
 *   1. 全局强制（系统设置 captcha_provider ≠ 0）—— 覆盖一切
 *   2. 用户偏好（已登录且 user.captcha_provider ≠ 0）
 *   3. 按访客 IP 归属：cf.country === 'CN' → hCaptcha，其余（含港澳台）→ Turnstile
 *
 * 注意：这里直接查 user 表而不走 userService，避免与 account-service 形成循环依赖。
 */

const captchaProviderService = {

	decideProvider,

	countryOf,

	/** 读取用户偏好（0 = 跟随默认） */
	async userPreference(c, userId) {

		if (!userId) {
			return captchaConst.provider.AUTO;
		}

		try {
			const row = await orm(c)
				.select({ captchaProvider: user.captchaProvider })
				.from(user)
				.where(eq(user.userId, userId))
				.get();

			return row?.captchaProvider || captchaConst.provider.AUTO;
		} catch (e) {
			console.error(`[Captcha] 读取用户偏好失败: ${e.message}`);
			return captchaConst.provider.AUTO;
		}
	},

	/**
	 * 解析本次请求应使用的 provider
	 * @param {*} c hono context
	 * @param {number|null} userId 已登录用户 id（未登录传 null）
	 */
	async resolve(c, userId = null) {

		const settingRow = await settingService.query(c);
		const globalProvider = settingRow.captchaProvider || captchaConst.provider.AUTO;

		// 全局已强制时无需查库
		const userProvider = globalProvider === captchaConst.provider.AUTO
			? await this.userPreference(c, userId)
			: captchaConst.provider.AUTO;

		return decideProvider({
			globalProvider,
			userProvider,
			country: countryOf(c)
		});
	},

	/**
	 * 首选 provider 若未配置（site key 或 secret 缺失），回退到另一家；
	 * 两家都没配置则返回首选（行为等同未启用验证）。
	 */
	fallback(settingRow, provider) {
		return pickUsableProvider(settingRow, provider);
	},

	/**
	 * 下发给前端的渲染配置（只含公开信息，绝不含 secret）
	 */
	async configFor(c, userId = null) {

		const settingRow = await settingService.query(c);
		const userProvider = await this.userPreference(c, userId);
		const provider = this.fallback(settingRow, decideProvider({
			globalProvider: settingRow.captchaProvider || captchaConst.provider.AUTO,
			userProvider,
			country: countryOf(c)
		}));

		return {
			provider,
			userProvider,
			turnstileSiteKey: settingRow.siteKey || '',
			hcaptchaSiteKey: settingRow.hcaptchaSiteKey || '',
			siteKey: captchaService.siteKeyOf(settingRow, provider)
		};
	},

	/**
	 * 便捷校验：自动解析 provider 后交给 captchaService
	 * @param {*} c
	 * @param {string} token
	 * @param {{userId?: number|null, action?: string}} options
	 */
	async verify(c, token, { userId = null, action = 'unknown' } = {}) {

		const settingRow = await settingService.query(c);
		const provider = this.fallback(settingRow, await this.resolve(c, userId));

		await captchaService.verify(c, token, { provider, action });

		return provider;
	},

	/**
	 * 当前是否需要对访客做验证（所选 provider 已配置 site key）
	 */
	async needVerify(c, userId = null) {

		const settingRow = await settingService.query(c);
		const provider = this.fallback(settingRow, await this.resolve(c, userId));

		return !!captchaService.siteKeyOf(settingRow, provider);
	}
};

export default captchaProviderService;
