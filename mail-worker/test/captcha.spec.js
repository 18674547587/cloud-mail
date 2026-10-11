import { describe, it, expect } from 'vitest';
import {
	decideProvider,
	pickUsableProvider,
	isValidPreference,
	siteKeyOf,
	secretOf,
	isConfigured
} from '../src/utils/captcha-utils';
import { captchaConst } from '../src/const/entity-const';

const { AUTO, TURNSTILE, HCAPTCHA } = captchaConst.provider;

describe('decideProvider 优先级', () => {

	it('全局强制覆盖一切', () => {
		expect(decideProvider({ globalProvider: HCAPTCHA, userProvider: TURNSTILE, country: 'US' })).toBe(HCAPTCHA);
		expect(decideProvider({ globalProvider: TURNSTILE, userProvider: HCAPTCHA, country: 'CN' })).toBe(TURNSTILE);
	});

	it('无全局强制时用户偏好优先于 IP 判定', () => {
		expect(decideProvider({ globalProvider: AUTO, userProvider: TURNSTILE, country: 'CN' })).toBe(TURNSTILE);
		expect(decideProvider({ globalProvider: AUTO, userProvider: HCAPTCHA, country: 'US' })).toBe(HCAPTCHA);
	});

	it('无偏好时按 IP：中国大陆 → hCaptcha', () => {
		expect(decideProvider({ country: 'CN' })).toBe(HCAPTCHA);
	});

	it('无偏好时按 IP：其余（含港澳台）→ Turnstile', () => {
		expect(decideProvider({ country: 'US' })).toBe(TURNSTILE);
		expect(decideProvider({ country: 'HK' })).toBe(TURNSTILE);
		expect(decideProvider({ country: 'TW' })).toBe(TURNSTILE);
		expect(decideProvider({ country: 'MO' })).toBe(TURNSTILE);
	});

	it('取不到国家码时保守使用 Turnstile', () => {
		expect(decideProvider({})).toBe(TURNSTILE);
		expect(decideProvider({ country: '' })).toBe(TURNSTILE);
	});

	it('非法值按未设置处理', () => {
		expect(decideProvider({ globalProvider: 9, userProvider: -1, country: 'CN' })).toBe(HCAPTCHA);
	});
});

describe('字段映射与配置判断', () => {

	const row = {
		siteKey: 'ts-site',
		secretKey: 'ts-secret',
		hcaptchaSiteKey: 'hc-site',
		hcaptchaSecretKey: 'hc-secret'
	};

	it('按 provider 取对应字段', () => {
		expect(siteKeyOf(row, TURNSTILE)).toBe('ts-site');
		expect(secretOf(row, TURNSTILE)).toBe('ts-secret');
		expect(siteKeyOf(row, HCAPTCHA)).toBe('hc-site');
		expect(secretOf(row, HCAPTCHA)).toBe('hc-secret');
	});

	it('字段缺失时返回空串而不报错', () => {
		expect(siteKeyOf({}, HCAPTCHA)).toBe('');
		expect(secretOf(undefined, TURNSTILE)).toBe('');
		expect(isConfigured({}, HCAPTCHA)).toBe(false);
	});

	it('site key 与 secret 齐全才算已配置', () => {
		expect(isConfigured(row, TURNSTILE)).toBe(true);
		expect(isConfigured({ hcaptchaSiteKey: 'x' }, HCAPTCHA)).toBe(false);
		expect(isConfigured({ hcaptchaSiteKey: 'x', hcaptchaSecretKey: 'y' }, HCAPTCHA)).toBe(true);
	});
});

describe('pickUsableProvider 回退（前后端必须一致）', () => {

	const onlyTurnstile = { siteKey: 'ts-site', secretKey: 'ts-secret' };
	const onlyHcaptcha = { hcaptchaSiteKey: 'hc-site', hcaptchaSecretKey: 'hc-secret' };
	const both = { ...onlyTurnstile, ...onlyHcaptcha };

	it('首选已配置则保持首选', () => {
		expect(pickUsableProvider(both, HCAPTCHA)).toBe(HCAPTCHA);
		expect(pickUsableProvider(both, TURNSTILE)).toBe(TURNSTILE);
	});

	it('首选未配置则回退到另一家', () => {
		expect(pickUsableProvider(onlyTurnstile, HCAPTCHA)).toBe(TURNSTILE);
		expect(pickUsableProvider(onlyHcaptcha, TURNSTILE)).toBe(HCAPTCHA);
	});

	it('两家都未配置则返回首选（等同未启用验证）', () => {
		expect(pickUsableProvider({}, HCAPTCHA)).toBe(HCAPTCHA);
		expect(pickUsableProvider({}, TURNSTILE)).toBe(TURNSTILE);
	});
});

describe('isValidPreference', () => {

	it('只接受 0/1/2', () => {
		[0, 1, 2].forEach(v => expect(isValidPreference(v)).toBe(true));
		[3, -1, '1', null, undefined, NaN].forEach(v => expect(isValidPreference(v)).toBe(false));
	});
});
