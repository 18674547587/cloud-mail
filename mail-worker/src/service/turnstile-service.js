import captchaService from './captcha-service';
import { captchaConst } from '../const/entity-const';

/**
 * 兼容层：历史上各处直接调用 turnstileService.verify(c, token)。
 * 现已统一到 captchaService，本对象固定使用 Turnstile。
 * 新代码请使用 captchaProviderService.verify(c, token, { userId, action })（自动按规则选择 provider）。
 */
const turnstileService = {
	verify(c, token, options = {}) {
		return captchaService.verify(c, token, {
			...options,
			provider: captchaConst.provider.TURNSTILE
		});
	}
};

export default turnstileService;
