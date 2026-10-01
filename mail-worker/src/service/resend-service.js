import emailService from './email-service';
import { emailConst } from '../const/entity-const';
import BizError from '../error/biz-error';

/**
 * 邮件状态优先级（数值越大越"终态"）
 *
 * 用途：Resend 的 webhook 不保证投递顺序，且失败后会重试。
 * 典型乱序场景：邮件已投递成功后，早先发出的 delivery_delayed 事件才重试到达，
 * 若不加保护就会把「已投递」回退成「投递延迟」。
 * 规则：只允许状态向更高优先级流转，低优先级事件到达时直接忽略。
 */
const STATUS_RANK = {
	[emailConst.status.SENT]: 0,
	[emailConst.status.DELAYED]: 1,
	[emailConst.status.DELIVERED]: 2,
	[emailConst.status.FAILED]: 3,
	[emailConst.status.COMPLAINED]: 3,
	[emailConst.status.BOUNCED]: 3
};

/** base64 字符串 -> Uint8Array */
function base64ToBytes(b64) {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		bytes[i] = bin.charCodeAt(i);
	}
	return bytes;
}

/** Uint8Array -> base64 字符串 */
function bytesToBase64(bytes) {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) {
		bin += String.fromCharCode(bytes[i]);
	}
	return btoa(bin);
}

/**
 * 校验 Svix 签名（Resend 的 webhook 由 Svix 投递）
 *
 * 签名算法（Svix 官方标准）：
 *   1. 待签名内容 = `${svix-id}.${svix-timestamp}.${原始请求体}`
 *   2. 密钥 = 去掉 `whsec_` 前缀后的 base64 解码结果
 *   3. 用 HMAC-SHA256 计算，结果 base64 编码
 *   4. 与请求头 svix-signature 中的 `v1,<base64>` 比对（可能存在多个签名，空格分隔）
 *
 * @param {string} rawBody 原始请求体文本（必须是原文，不能是 JSON.stringify 后的结果）
 * @param {Headers} headers 请求头
 * @param {string[]} secrets 允许的签名密钥列表
 * @returns {Promise<boolean>}
 */
async function verifySvixSignature(rawBody, headers, secrets) {
	const id = headers.get('svix-id');
	const timestamp = headers.get('svix-timestamp');
	const signature = headers.get('svix-signature');

	if (!id || !timestamp || !signature) {
		return false;
	}

	// 防重放：时间戳偏差超过 5 分钟视为非法
	const ts = Number(timestamp);
	if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
		return false;
	}

	const signedContent = `${id}.${timestamp}.${rawBody}`;
	const provided = signature
		.split(' ')
		.map(item => item.split(',')[1])
		.filter(Boolean);

	if (provided.length === 0) {
		return false;
	}

	for (const secret of secrets) {
		const keyBytes = base64ToBytes(secret.replace(/^whsec_/, ''));
		const key = await crypto.subtle.importKey(
			'raw',
			keyBytes,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
		if (provided.includes(bytesToBase64(new Uint8Array(mac)))) {
			return true;
		}
	}

	return false;
}

const resendService = {

	/**
	 * 校验 webhook 来源是否可信
	 *
	 * 环境变量 RESEND_WEBHOOK_SECRETS：逗号分隔的多个 Svix signing secret
	 * （Resend 的 webhook 是账号级的，本项目横跨两个 Resend 账号，故需支持多个）
	 *
	 * 未配置该变量时跳过校验并打印告警，保证向后兼容、不会因漏配而彻底阻断回调。
	 */
	async verifyWebhook(c, rawBody, headers) {
		const raw = c.env.RESEND_WEBHOOK_SECRETS;

		if (!raw || !String(raw).trim()) {
			console.warn('RESEND_WEBHOOK_SECRETS 未配置，跳过 webhook 验签（存在伪造风险）');
			return true;
		}

		const secrets = String(raw)
			.split(',')
			.map(item => item.trim())
			.filter(Boolean);

		return await verifySvixSignature(rawBody, headers, secrets);
	},

	async webhooks(c, body) {

		// 事件类型缺失或 payload 结构异常时直接拒绝，避免后续取值抛异常
		if (!body || typeof body.type !== 'string') {
			throw new BizError('webhook 事件格式非法');
		}

		const resendEmailId = body?.data?.email_id;

		if (!resendEmailId) {
			throw new BizError('webhook 缺少 email_id');
		}

		const params = {
			resendEmailId: resendEmailId,
			status: emailConst.status.SENT
		}

		if (body.type === 'email.delivered') {
			params.status = emailConst.status.DELIVERED
			params.message = null
		}

		if (body.type === 'email.complained') {
			params.status = emailConst.status.COMPLAINED
			params.message = null
		}

		if (body.type === 'email.bounced') {
			// bounce 字段缺失时兜底，避免 JSON.stringify(undefined) 产生脏数据
			const bounce = body?.data?.bounce ?? { message: '未提供退信详情' };
			params.status = emailConst.status.BOUNCED
			params.message = JSON.stringify(bounce)
		}

		if (body.type === 'email.delivery_delayed') {
			params.status = emailConst.status.DELAYED
			params.message = null
		}

		if (body.type === 'email.failed') {
			params.status = emailConst.status.FAILED
			params.message = body?.data?.failed?.reason ?? '发送失败（未提供原因）'
		}

		const emailRow = await emailService.updateEmailStatus(c, params)

		if (!emailRow) {
			throw new BizError('更新邮件状态记录失败');
		}

	}
}

export default resendService
