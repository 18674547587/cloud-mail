import { describe, it, expect } from 'vitest';
import avatarService, { resolveAvatarMime, AVATAR_MIME } from '../src/service/avatar-service';
import constant from '../src/const/constant';

describe('resolveAvatarMime 头像格式白名单', () => {

	it('允许 png / jpg / jpeg / webp / gif', () => {
		expect(resolveAvatarMime('a.png')).toBe('image/png');
		expect(resolveAvatarMime('a.jpg')).toBe('image/jpeg');
		expect(resolveAvatarMime('a.jpeg')).toBe('image/jpeg');
		expect(resolveAvatarMime('a.webp')).toBe('image/webp');
		expect(resolveAvatarMime('a.gif')).toBe('image/gif');
	});

	it('扩展名大小写不敏感', () => {
		expect(resolveAvatarMime('PHOTO.PNG')).toBe('image/png');
		expect(resolveAvatarMime('photo.JpEg')).toBe('image/jpeg');
	});

	it('取最后一段扩展名（双扩展名不能绕过白名单）', () => {
		expect(resolveAvatarMime('evil.png.exe')).toBeNull();
		expect(resolveAvatarMime('evil.png.js')).toBeNull();
		expect(resolveAvatarMime('ok.photo.png')).toBe('image/png');
	});

	it('拒绝非法与缺失扩展名', () => {
		expect(resolveAvatarMime('a.svg')).toBeNull();
		expect(resolveAvatarMime('a.html')).toBeNull();
		expect(resolveAvatarMime('a.ico')).toBeNull();
		expect(resolveAvatarMime('noext')).toBeNull();
		expect(resolveAvatarMime('')).toBeNull();
		expect(resolveAvatarMime(null)).toBeNull();
		expect(resolveAvatarMime(undefined)).toBeNull();
		expect(resolveAvatarMime(123)).toBeNull();
	});

	it('MIME 表只包含图片类型', () => {
		Object.values(AVATAR_MIME).forEach(mime => {
			expect(mime.startsWith('image/')).toBe(true);
		});
	});
});

describe('头像常量', () => {

	it('对象前缀为 avatar/，与公开读取路由 /avatar/ 对应', () => {
		expect(constant.AVATAR_PREFIX).toBe('avatar/');
	});

	it('存在防滥用硬上限', () => {
		expect(constant.AVATAR_MAX_SIZE).toBe(20 * 1024 * 1024);
	});
});

describe('avatarService.toUrl', () => {

	const c = { req: { url: 'https://m.1206201.xyz/api/my/loginUserInfo?x=1' } };

	it('拼接为可公开访问的绝对地址', () => {
		expect(avatarService.toUrl(c, 'avatar/abc123.png')).toBe('https://m.1206201.xyz/avatar/abc123.png');
	});

	it('未设置头像时返回空串', () => {
		expect(avatarService.toUrl(c, '')).toBe('');
		expect(avatarService.toUrl(c, null)).toBe('');
	});
});
