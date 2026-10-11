import orm from '../entity/orm';
import user from '../entity/user';
import { eq } from 'drizzle-orm';
import r2Service from './r2-service';
import s3Service from './s3-service';
import constant from '../const/constant';
import KvConst from '../const/kv-const';
import fileUtils from '../utils/file-utils';
import { v4 as uuidv4 } from 'uuid';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

// 允许的头像格式：扩展名 → MIME
// 以扩展名为准（而不是前端传来的 contentType），避免对象存进桶里 Content-Type 错误，
// 导致浏览器把图片当附件下载而不是直接显示。
export const AVATAR_MIME = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif'
};

/**
 * 由文件名解析头像 MIME（纯函数，便于单测）
 * @returns {string|null} 允许的 MIME，非法格式返回 null
 */
export function resolveAvatarMime(filename) {

	if (!filename || typeof filename !== 'string') {
		return null;
	}

	const index = filename.lastIndexOf('.');

	if (index === -1) {
		return null;
	}

	const ext = filename.slice(index).toLowerCase();

	return AVATAR_MIME[ext] || null;
}

const avatarService = {

	/**
	 * 申请头像直传凭证：前端拿到 uploadUrl 后直接 PUT 到对象存储（文件不经过 Worker）
	 * 返回的 key 需再调用 save() 才会真正挂到用户身上。
	 */
	async presign(c, params, userId) {

		const { filename } = params;

		if (!filename) {
			throw new BizError(t('avatarFilenameEmpty'));
		}

		// 与附件一致：只有 S3 存储支持前端直传
		const storageType = await r2Service.storageType(c);

		if (storageType !== 'S3') {
			throw new BizError(t('noPresignStorage'));
		}

		// 扩展名即格式白名单（同时决定了对象存进桶里的 Content-Type）
		const contentType = resolveAvatarMime(filename);

		if (!contentType) {
			throw new BizError(t('avatarFormatInvalid'));
		}
		// 大小由前端提示为主，这里只做防滥用的宽松硬上限
		const size = Number(params.size);

		if (size && size > constant.AVATAR_MAX_SIZE) {
			throw new BizError(t('avatarTooLarge'));
		}

		const key = constant.AVATAR_PREFIX + uuidv4().replace(/-/g, '') + fileUtils.getExtFileName(filename).toLowerCase();

		// 记录上传者，防止拿别人申请到的 key 挂到自己（或别人）名下
		await c.env.kv.put(KvConst.AVATAR_UPLOAD + key, JSON.stringify({
			userId,
			contentType
		}), { expirationTtl: 60 * 60 * 24 });

		const uploadUrl = await s3Service.presignPut(c, key, contentType);

		return {
			key,
			uploadUrl,
			headers: { 'Content-Type': contentType }
		};
	},

	/**
	 * 校验直传的 key 并挂到目标用户身上，同时删除旧头像对象
	 * @param userId 发起人（用于校验 key 归属）
	 * @param targetUserId 实际写入的用户
	 */
	async save(c, params, userId, targetUserId) {

		const { key } = params;

		if (!key || !key.startsWith(constant.AVATAR_PREFIX)) {
			throw new BizError(t('avatarKeyInvalid'));
		}

		await avatarService.verifyUpload(c, key, userId);

		const targetRow = await orm(c).select().from(user).where(eq(user.userId, targetUserId)).get();

		if (!targetRow) {
			throw new BizError(t('userNotExist'));
		}

		const oldKey = targetRow.avatar;

		await orm(c).update(user).set({ avatar: key }).where(eq(user.userId, targetUserId)).run();

		// 旧头像及时清理，避免存储只增不减（只在确认是头像对象时才删）
		if (oldKey && oldKey.startsWith(constant.AVATAR_PREFIX) && oldKey !== key) {
			try {
				await r2Service.delete(c, oldKey);
			} catch (e) {
				console.warn(`旧头像删除失败：${oldKey} ${e.message}`);
			}
		}

		return { avatar: key };
	},

	/**
	 * 校验 key 归属：优先读 KV 记录，记录过期时退化为确认对象存在
	 */
	async verifyUpload(c, key, userId) {

		const record = await c.env.kv.get(KvConst.AVATAR_UPLOAD + key, { type: 'json' });

		if (record) {
			if (record.userId !== userId) {
				throw new BizError(t('avatarUploadNotOwner'), 403);
			}
			return record;
		}

		const head = await s3Service.headObj(c, key);

		if (!head) {
			throw new BizError(t('avatarUploadNotFound'));
		}

		return { size: head.size, contentType: head.contentType };
	},

	/**
	 * 清除头像（恢复默认文字头像）
	 */
	async remove(c, targetUserId) {

		const targetRow = await orm(c).select().from(user).where(eq(user.userId, targetUserId)).get();

		if (!targetRow) {
			throw new BizError(t('userNotExist'));
		}

		const oldKey = targetRow.avatar;

		await orm(c).update(user).set({ avatar: '' }).where(eq(user.userId, targetUserId)).run();

		if (oldKey && oldKey.startsWith(constant.AVATAR_PREFIX)) {
			try {
				await r2Service.delete(c, oldKey);
			} catch (e) {
				console.warn(`头像删除失败：${oldKey} ${e.message}`);
			}
		}

		return { avatar: '' };
	},

	/**
	 * 由对象 key 生成前端可直接引用的绝对地址
	 * 走 index.js 的公开读取分支（/avatar/<file>），无需鉴权、key 含随机串不可枚举
	 */
	toUrl(c, key) {
		if (!key) {
			return '';
		}
		const origin = new URL(c.req.url).origin;
		return `${origin}/${key}`;
	}
};

export default avatarService;
