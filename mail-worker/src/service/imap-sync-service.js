/**
 * IMAP 同步服务
 *
 * 用途：把云邮（Cloud Mail）的账号密码与邮件同步到 Stalwart（IMAP 出口服务器），
 * 使第三方邮件客户端（Foxmail / Outlook / 手机邮件 App）能用
 * 「云邮的邮箱地址 + 云邮的密码」直接登录 IMAP。
 *
 * 背景：Stalwart 内置的密码格式（{SHA256} / {SSHA256} 等）无法直接验证云邮的
 * 哈希 —— 云邮是 Base64(SHA256(salt + password))（盐在前），
 * 而 {SSHA256} 是 Base64(SHA256(password + salt) + salt)（盐在后），二者不兼容。
 * 因此改为「用户登录云邮时把明文密码顺手同步过去」，
 * 由 Stalwart 自己用它选定的算法（argon2id）存储。
 *
 * 投递路径：收信时把原始报文通过 JMAP 的 upload + Email/import 写入目标账号的 INBOX。
 *
 * 配置（Worker Secret）：
 *   STALWART_URL   —— 例如 https://imap.1206201.xyz/jmap
 *   STALWART_AUTH  —— "用户名:密码" 明文，内部转 Basic 认证
 *
 * 未配置时全部方法静默跳过，不影响云邮自身功能。
 */

const JMAP_ADMIN = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];
const JMAP_MAIL = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];

const imapSyncService = {

	/** 是否已配置（未配置则所有同步动作静默跳过） */
	enabled(c) {
		return !!(c.env.STALWART_URL && c.env.STALWART_AUTH);
	},

	/**
	 * 调用 Stalwart 的 JMAP API
	 * @param using 能力列表，管理操作用 JMAP_ADMIN，邮件操作用 JMAP_MAIL
	 * @returns {Promise<Object|null>} 未配置时返回 null
	 */
	async call(c, methodCalls, using = JMAP_ADMIN) {

		if (!this.enabled(c)) {
			return null;
		}

		const res = await fetch(c.env.STALWART_URL, {
			method: 'POST',
			headers: {
				'Authorization': 'Basic ' + btoa(c.env.STALWART_AUTH),
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				using: using,
				methodCalls: methodCalls
			})
		});

		if (!res.ok) {
			throw new Error('Stalwart API ' + res.status);
		}

		return await res.json();
	},

	/**
	 * 按邮箱地址在 Stalwart 里查找账号 id
	 *
	 * 说明：x:Account/query 的 name 过滤只匹配本地部分（如 "admin"），
	 * 不同域名下可能重名（admin@1206201.xyz 与 admin@a.260040.xyz），
	 * 所以这里全量拉取后用 emailAddress 精确比对。自用规模（几十个账号）足够。
	 */
	async findAccountId(c, email) {

		const r = await this.call(c, [['x:Account/get', { ids: null }, 'g']]);

		const list = r?.methodResponses?.[0]?.[1]?.list || [];
		const target = String(email).toLowerCase();
		const hit = list.find(item => String(item.emailAddress || '').toLowerCase() === target);

		return hit ? hit.id : null;
	},

	/**
	 * 同步密码：让客户端能用云邮的邮箱 + 密码登录 IMAP
	 *
	 * 设计原则：绝不影响云邮自身的登录流程 —— 任何异常都吞掉并记日志。
	 */
	async syncPassword(c, email, password) {

		try {

			if (!this.enabled(c)) {
				return false;
			}

			const id = await this.findAccountId(c, email);

			if (!id) {
				// 该邮箱在 Stalwart 侧不存在，跳过（不影响登录）
				return false;
			}

			await this.call(c, [['x:Account/set', {
				update: {
					[id]: {
						credentials: {
							'0': { '@type': 'Password', secret: password }
						}
					}
				}
			}, 's']]);

			return true;

		} catch (e) {
			console.error('[IMAP] 密码同步失败:', e);
			return false;
		}
	},

	/**
	 * 上传原始邮件报文，返回 blobId
	 */
	async uploadBlob(c, accountId, rawMessage) {

		const base = String(c.env.STALWART_URL).replace(/\/+$/, '');
		const res = await fetch(base + '/upload/' + accountId + '/', {
			method: 'POST',
			headers: {
				'Authorization': 'Basic ' + btoa(c.env.STALWART_AUTH),
				'Content-Type': 'message/rfc822'
			},
			body: rawMessage
		});

		if (!res.ok) {
			throw new Error('Stalwart upload ' + res.status);
		}

		const json = await res.json();
		return json.blobId || null;
	},

	/**
	 * 投递邮件：收信时把原始报文写入目标账号的 INBOX
	 *
	 * @param rawMessage 原始邮件报文（字符串或 Uint8Array 均可，fetch body 都支持）
	 */
	async deliverEmail(c, toEmail, rawMessage) {

		try {

			if (!this.enabled(c) || !rawMessage) {
				return false;
			}

			const accountId = await this.findAccountId(c, toEmail);

			if (!accountId) {
				// 收件人在 Stalwart 侧没有账号，跳过
				return false;
			}

			// 1) 找到 INBOX
			const mb = await this.call(c, [['Mailbox/get', { accountId: accountId }, 'm']], JMAP_MAIL);
			const inbox = (mb?.methodResponses?.[0]?.[1]?.list || []).find(m => m.role === 'inbox');

			if (!inbox) {
				return false;
			}

			// 2) 上传报文
			const blobId = await this.uploadBlob(c, accountId, rawMessage);

			if (!blobId) {
				return false;
			}

			// 3) 导入到 INBOX
			await this.call(c, [['Email/import', {
				accountId: accountId,
				emails: {
					'1': {
						blobId: blobId,
						mailboxIds: { [inbox.id]: true }
					}
				}
			}, 'i']], JMAP_MAIL);

			return true;

		} catch (e) {
			console.error('[IMAP] 邮件投递失败:', e);
			return false;
		}
	},

	/**
	 * 把结构化邮件数据构造成 RFC822 报文（Uint8Array）。
	 *
	 * 用途：站内邮件（收件人同属云邮域名）走的是 HandleOnSiteEmail，不经过
	 * Cloudflare Email Routing，因此收信流程里的投递钩子不会触发。这里手工构造
	 * 一份最简 MIME 报文补投，否则 IMAP 客户端看不到站内邮件。
	 */
	buildRawMessage({ fromEmail, fromName, toEmail, toName, subject, html, text, messageId }) {

		const CRLF = '\r\n';

		const b64 = (s) => {
			const bytes = new TextEncoder().encode(s || '');
			let bin = '';
			for (let i = 0; i < bytes.length; i += 0x8000) {
				bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
			}
			return btoa(bin);
		};

		const wrap = (s) => (s.match(/.{1,76}/g) || []).join(CRLF);

		// 非 ASCII 头字段用 RFC 2047 B 编码
		const hdr = (v) => (/^[\x20-\x7E]*$/.test(v || '') ? (v || '') : '=?UTF-8?B?' + b64(v) + '?=');

		const lines = [
			`From: ${fromName ? hdr(fromName) + ' ' : ''}<${fromEmail}>`,
			`To: ${toName ? hdr(toName) + ' ' : ''}<${toEmail}>`,
			`Subject: ${hdr(subject || '')}`,
			`Date: ${new Date().toUTCString()}`,
		];

		if (messageId) {
			lines.push(`Message-ID: <${messageId}>`);
		}

		lines.push('MIME-Version: 1.0');
		lines.push('Content-Type: text/html; charset=UTF-8');
		lines.push('Content-Transfer-Encoding: base64');

		const body = html || `<pre>${(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;

		return new TextEncoder().encode(lines.join(CRLF) + CRLF + CRLF + wrap(b64(body)) + CRLF);
	}
};

export default imapSyncService;
