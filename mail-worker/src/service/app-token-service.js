/**
 * 设备令牌（App Token）服务 —— 为安卓客户端提供的专用凭证体系
 *
 * 设计目标：
 *   1. 不暴露 jwt_secret（/api/login/api 的做法等于把签发密钥发给每个用户）
 *   2. 不依赖 Turnstile（原生 App 集成人机验证成本高、体验差）
 *   3. 可按设备单独吊销
 *
 * 存储结构（KV）：
 *   app-token:<sha256hex(明文令牌)>  → { userId, tokenId, name, createTime, lastUsedTime }
 *   app-token-uid:<userId>           → [ { tokenId, hash, name, createTime, lastUsedTime } ]
 *   app-login-fail:<sha256hex(email)> → 连续失败次数（用于简易限流）
 *
 * 安全要点：
 *   - KV 中只存 SHA-256 哈希，明文令牌仅在创建时返回一次
 *   - 令牌换取的 JWT 与普通登录完全一致，权限不提升、不降级
 */
import BizError from '../error/biz-error';
import userService from './user-service';
import KvConst from '../const/kv-const';
import dayjs from 'dayjs';
import { isDel, userConst } from '../const/entity-const';

const TOKEN_PREFIX = 'cm_';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365; // 设备令牌有效期 1 年
const MAX_FAIL_COUNT = 5;
const FAIL_LOCK_SECONDS = 60 * 15;

const encoder = new TextEncoder();

async function sha256Hex(str) {
	const buf = await crypto.subtle.digest('SHA-256', encoder.encode(str));
	return Array.from(new Uint8Array(buf))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
}

function genTokenString() {
	const arr = new Uint8Array(32);
	crypto.getRandomValues(arr);
	const b64 = btoa(String.fromCharCode(...arr))
		.replace(/=+$/, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
	return TOKEN_PREFIX + b64;
}

const appTokenService = {

	/** 创建一个新的设备令牌（需要已登录的 JWT 才能调用） */
	async create(c, params, userId) {

		let name = (params && params.name) || '未命名设备';
		name = String(name).slice(0, 40);

		const tokenId = crypto.randomUUID().replace(/-/g, '');
		const plainToken = genTokenString();
		const hash = await sha256Hex(plainToken);
		const now = dayjs().toISOString();

		const record = {
			userId,
			tokenId,
			name,
			createTime: now,
			lastUsedTime: null
		};

		await c.env.kv.put(KvConst.APP_TOKEN + hash, JSON.stringify(record), {
			expirationTtl: TOKEN_TTL_SECONDS
		});

		const uidKey = KvConst.APP_TOKEN_UID + userId;
		let list = await c.env.kv.get(uidKey, { type: 'json' }) || [];

		// 单用户最多保留 20 个设备令牌，超出则淘汰最久未使用的
		if (list.length >= 20) {
			list.sort((a, b) => (a.lastUsedTime || a.createTime).localeCompare(b.lastUsedTime || b.createTime));
			const removed = list.shift();
			if (removed) {
				await c.env.kv.delete(KvConst.APP_TOKEN + removed.hash);
			}
		}

		list.push({ tokenId, hash, name, createTime: now, lastUsedTime: null });
		await c.env.kv.put(uidKey, JSON.stringify(list), { expirationTtl: TOKEN_TTL_SECONDS });

		// 明文令牌只在这里返回一次，之后无法再次获取
		return { token: plainToken, tokenId, name };
	},

	/** 列出当前用户的设备令牌（不含明文） */
	async list(c, userId) {
		const list = await c.env.kv.get(KvConst.APP_TOKEN_UID + userId, { type: 'json' }) || [];
		return list.map(item => ({
			tokenId: item.tokenId,
			name: item.name,
			createTime: item.createTime,
			lastUsedTime: item.lastUsedTime
		}));
	},

	/** 吊销指定设备令牌 */
	async revoke(c, params, userId) {

		const tokenId = params && params.tokenId;

		if (!tokenId) {
			throw new BizError('缺少 tokenId');
		}

		const uidKey = KvConst.APP_TOKEN_UID + userId;
		const list = await c.env.kv.get(uidKey, { type: 'json' }) || [];
		const index = list.findIndex(item => item.tokenId === tokenId);

		if (index === -1) {
			throw new BizError('设备令牌不存在');
		}

		await c.env.kv.delete(KvConst.APP_TOKEN + list[index].hash);
		list.splice(index, 1);
		await c.env.kv.put(uidKey, JSON.stringify(list), { expirationTtl: TOKEN_TTL_SECONDS });

		return true;
	},

	/**
	 * 校验设备令牌并返回 userId
	 * 校验通过后会把 lastUsedTime 写回（KV 写入不频繁，可接受）
	 */
	async verifyAndGetUserId(c, params) {

		const email = params && params.email;
		const deviceToken = params && params.deviceToken;

		if (!email || !deviceToken) {
			throw new BizError('邮箱与设备令牌不能为空');
		}

		// ---- 简易限流：同一邮箱连续失败 5 次，锁定 15 分钟 ----
		const failKey = KvConst.APP_LOGIN_FAIL + await sha256Hex(String(email).toLowerCase());
		const failCount = Number(await c.env.kv.get(failKey)) || 0;

		if (failCount >= MAX_FAIL_COUNT) {
			throw new BizError('尝试次数过多，请 15 分钟后再试', 429);
		}

		const hash = await sha256Hex(String(deviceToken).trim());
		const record = await c.env.kv.get(KvConst.APP_TOKEN + hash, { type: 'json' });

		if (!record) {
			await c.env.kv.put(failKey, String(failCount + 1), { expirationTtl: FAIL_LOCK_SECONDS });
			throw new BizError('设备令牌无效或已吊销', 401);
		}

		// ---- 校验该令牌对应的用户与传入邮箱是否一致 ----
		const userRow = await userService.selectByEmailIncludeDel(c, email);

		if (!userRow || userRow.userId !== record.userId) {
			await c.env.kv.put(failKey, String(failCount + 1), { expirationTtl: FAIL_LOCK_SECONDS });
			throw new BizError('设备令牌与邮箱不匹配', 401);
		}

		if (userRow.isDel === isDel.DELETE) {
			throw new BizError('账号已被删除', 401);
		}

		if (userRow.status === userConst.status.BAN) {
			throw new BizError('账号已被禁用', 401);
		}

		// ---- 成功：清除失败计数 + 更新 lastUsedTime ----
		await c.env.kv.delete(failKey);

		record.lastUsedTime = dayjs().toISOString();
		await c.env.kv.put(KvConst.APP_TOKEN + hash, JSON.stringify(record), {
			expirationTtl: TOKEN_TTL_SECONDS
		});

		const uidKey = KvConst.APP_TOKEN_UID + record.userId;
		const list = await c.env.kv.get(uidKey, { type: 'json' }) || [];
		const index = list.findIndex(item => item.tokenId === record.tokenId);

		if (index > -1) {
			list[index].lastUsedTime = record.lastUsedTime;
			await c.env.kv.put(uidKey, JSON.stringify(list), { expirationTtl: TOKEN_TTL_SECONDS });
		}

		// 顺带返回规范化后的邮箱，调用方无需再查一次数据库
		return { userId: record.userId, email: userRow.email };
	}

};

export default appTokenService;
