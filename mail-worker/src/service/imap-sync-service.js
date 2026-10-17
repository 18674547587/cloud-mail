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

import r2Service from './r2-service';

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
	 * 按邮箱域名查找 Stalwart 的 domain id
	 *
	 * 说明：Stalwart 的域名是独立对象（x:Domain），建号时必须绑定 domainId。
	 * 若云邮新增了域名而 Stalwart 侧未配置，这里返回 null，调用方跳过建号并记日志。
	 */
	async findDomainId(c, email) {

		const domain = String(email).split('@')[1]?.toLowerCase();

		if (!domain) {
			return null;
		}

		const r = await this.call(c, [['x:Domain/get', { ids: null }, 'g']]);

		const list = r?.methodResponses?.[0]?.[1]?.list || [];

		const hit = list.find(item => String(item.name || '').toLowerCase() === domain);

		return hit ? hit.id : null;
	},

	/**
	 * 确保 Stalwart 侧存在该邮箱域名；不存在则自动创建（Stalwart 会自动生成 DKIM 密钥）。
	 *
	 * 用途：云邮新增域名后，账号同步不必再手工在 Stalwart 加 domain。
	 * 前提：调用方传入的邮箱域名已通过云邮侧 env.domain 白名单校验。
	 */
	async ensureDomain(c, email) {

		try {

			const id = await this.findDomainId(c, email);

			if (id) {
				return id;
			}

			const domain = String(email).split('@')[1]?.toLowerCase();

			if (!domain) {
				return null;
			}

			const r = await this.call(c, [['x:Domain/set', {
				create: { 'n1': { name: domain } }
			}, 'c']]);

			const created = r?.methodResponses?.[0]?.[1]?.created?.n1;

			if (!created) {
				console.warn('[IMAP] 域名创建失败:', domain,
					JSON.stringify(r?.methodResponses?.[0]?.[1]?.notCreated || {}));
				return null;
			}

			console.log('[IMAP] 已创建域名:', domain, '->', created.id);

			return created.id;

		} catch (e) {
			console.error('[IMAP] ensureDomain 失败:', email, e);
			return null;
		}
	},

	/**
	 * 确保 Stalwart 侧存在该邮箱账号，并把密码同步为云邮的密码。
	 *
	 * 用于「云邮侧新增用户 / 新增邮箱」后自动补齐 IMAP 出口账号：
	 *   - 账号不存在 → 创建（@type User，绑定对应 domain，Stalwart 自动初始化默认文件夹）
	 *   - 账号已存在 → 只更新密码
	 *
	 * 设计原则：任何异常都吞掉并记日志，绝不影响云邮自身流程。
	 * @returns {Promise<boolean>} 是否成功（未配置 / 域名未登记 / 建号失败均为 false）
	 */
	async ensureAccount(c, email, password) {

		try {

			if (!this.enabled(c) || !email || !password) {
				return false;
			}

			const id = await this.findAccountId(c, email);

			// 已存在：只同步密码
			if (id) {
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
			}

			const domainId = await this.ensureDomain(c, email);

			if (!domainId) {
				console.warn('[IMAP] 域名创建/查找失败，跳过建号:', email);
				return false;
			}

			const r = await this.call(c, [['x:Account/set', {
				create: {
					'n1': {
						'@type': 'User',
						name: String(email).split('@')[0],
						domainId: domainId,
						credentials: {
							'0': { '@type': 'Password', secret: password }
						},
						roles: { '@type': 'User' }
					}
				}
			}, 'c']]);

			const created = r?.methodResponses?.[0]?.[1]?.created?.n1;

			if (!created) {
				console.warn('[IMAP] 建号失败:', email,
					JSON.stringify(r?.methodResponses?.[0]?.[1]?.notCreated || {}));
				return false;
			}

			console.log('[IMAP] 已建号:', email, '->', created.id);

			return true;

		} catch (e) {
			console.error('[IMAP] ensureAccount 失败:', email, e);
			return false;
		}
	},

	/**
	 * 仅确保账号存在（不存在则用随机密码创建），**不覆盖已有密码**。
	 *
	 * 用于「添加邮箱但调用方没提供密码」的场景：必须先建号，否则站内发信
	 * 会在 RCPT 阶段被 Stalwart 拒收（smtp.mailbox-does-not-exist）。
	 * 用户下次登录云邮时，登录流程会用真实密码覆盖随机密码。
	 */
	async ensureAccountExists(c, email) {

		try {

			if (!this.enabled(c) || !email) {
				return false;
			}

			if (await this.findAccountId(c, email)) {
				return true;
			}

			const domainId = await this.ensureDomain(c, email);

			if (!domainId) {
				return false;
			}

			const pw = crypto.randomUUID() + crypto.randomUUID();

			const r = await this.call(c, [['x:Account/set', {
				create: {
					'n1': {
						'@type': 'User',
						name: String(email).split('@')[0],
						domainId: domainId,
						credentials: { '0': { '@type': 'Password', secret: pw } },
						roles: { '@type': 'User' }
					}
				}
			}, 'c']]);

			const created = r?.methodResponses?.[0]?.[1]?.created?.n1;

			if (created) {
				console.log('[IMAP] 已建号(随机密码):', email, '->', created.id);
				return true;
			}

			console.warn('[IMAP] 建号失败:', email,
				JSON.stringify(r?.methodResponses?.[0]?.[1]?.notCreated || {}));
			return false;

		} catch (e) {
			console.error('[IMAP] ensureAccountExists 失败:', email, e);
			return false;
		}
	},

	/**
	 * 停用 Stalwart 侧账号：清空 credentials（账号与邮件保留，可逆）。
	 *
	 * 用于「云邮删除用户 / 删除邮箱 / 封禁用户」后立即切断 IMAP/SMTP 登录。
	 * 恢复路径：解禁或重新添加后，用户下次登录云邮时 ensureAccount 会自动重建凭证。
	 */
	async disableAccount(c, email) {

		try {

			if (!this.enabled(c) || !email) {
				return false;
			}

			const id = await this.findAccountId(c, email);

			if (!id) {
				return false;
			}

			await this.call(c, [['x:Account/set', {
				update: { [id]: { credentials: {} } }
			}, 'd']]);

			console.log('[IMAP] 已停用:', email);

			return true;

		} catch (e) {
			console.error('[IMAP] disableAccount 失败:', email, e);
			return false;
		}
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
	 * 按 Message-ID 在指定 Stalwart 账号里定位邮件（取最近 300 封后本地比对）
	 */
	async findEmailByMessageId(c, accountId, messageId) {

		const target = String(messageId || '').replace(/[<>]/g, '').toLowerCase();

		if (!target) {
			return null;
		}

		const q = await this.call(c, [['Email/query', {
			accountId: accountId,
			sort: [{ property: 'receivedAt', isAscending: false }],
			limit: 300
		}, 'q']], JMAP_MAIL);

		const ids = q?.methodResponses?.[0]?.[1]?.ids || [];

		if (ids.length === 0) {
			return null;
		}

		const g = await this.call(c, [['Email/get', {
			accountId: accountId,
			ids: ids,
			properties: ['id', 'messageId', 'keywords', 'mailboxIds']
		}, 'g']], JMAP_MAIL);

		const list = g?.methodResponses?.[0]?.[1]?.list || [];

		return list.find(e => (e.messageId || []).some(m =>
			String(m).replace(/[<>]/g, '').toLowerCase() === target)) || null;
	},

	/**
	 * 把云邮侧的已读 / 星标 / 删除同步到 Stalwart
	 * flags: { seen?: boolean, flagged?: boolean, deleted?: boolean }
	 */
	async syncMailFlags(c, toEmail, messageId, flags) {

		try {

			if (!this.enabled(c) || !toEmail || !messageId) {
				return false;
			}

			const accountId = await this.findAccountId(c, toEmail);

			if (!accountId) {
				return false;
			}

			const emailObj = await this.findEmailByMessageId(c, accountId, messageId);

			if (!emailObj) {
				return false;
			}

			const patch = {};

			if (typeof flags.seen === 'boolean' || typeof flags.flagged === 'boolean') {
				const kw = { ...(emailObj.keywords || {}) };
				if (typeof flags.seen === 'boolean') {
					if (flags.seen) {
						kw['$seen'] = true;
					} else {
						delete kw['$seen'];
					}
				}
				if (typeof flags.flagged === 'boolean') {
					if (flags.flagged) {
						kw['$flagged'] = true;
					} else {
						delete kw['$flagged'];
					}
				}
				patch.keywords = kw;
			}

			if (flags.deleted) {
				const mb = await this.call(c, [['Mailbox/get', { accountId: accountId }, 'm']], JMAP_MAIL);
				const trash = (mb?.methodResponses?.[0]?.[1]?.list || []).find(m => m.role === 'trash');
				if (trash) {
					patch.mailboxIds = { [trash.id]: true };
				}
			}

			if (Object.keys(patch).length === 0) {
				return false;
			}

			await this.call(c, [['Email/set', {
				accountId: accountId,
				update: { [emailObj.id]: patch }
			}, 's']], JMAP_MAIL);

			return true;

		} catch (e) {
			console.error('[IMAP] syncMailFlags 失败:', toEmail, messageId, e);
			return false;
		}
	},

	/**
	 * 读取附件内容并转 base64，供 buildRawMessage 内联。
	 * 总大小超过 maxTotal 时停止追加，避免 Worker 内存/CPU 超限（只投已读部分）。
	 */
	async loadAttachments(c, attList, maxTotal = 3 * 1024 * 1024) {

		const out = [];
		let total = 0;

		for (const a of attList || []) {

			if (!a || !a.key) {
				continue;
			}

			const size = Number(a.size) || 0;

			if (total + size > maxTotal) {
				console.warn('[IMAP] 附件总量超限，跳过:', a.filename, '已累计', total);
				break;
			}

			try {

				const resp = await r2Service.toObjResp(c, a.key);

				if (!resp || !resp.ok) {
					console.warn('[IMAP] 附件读取失败:', a.filename, resp?.status);
					continue;
				}

				const bytes = new Uint8Array(await resp.arrayBuffer());
				let bin = '';

				for (let i = 0; i < bytes.length; i += 0x8000) {
					bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
				}

				out.push({
					filename: a.filename || 'attachment',
					mimeType: a.mimeType || 'application/octet-stream',
					disposition: a.disposition || 'attachment',
					contentId: a.contentId || null,
					base64: btoa(bin)
				});

				total += size || bytes.length;

			} catch (e) {
				console.error('[IMAP] 附件读取异常:', a.filename, e);
			}
		}

		return out;
	},

	/**
	 * 把结构化邮件数据构造成 RFC822 报文（Uint8Array）。
	 *
	 * 无附件时输出单 part text/html；有附件时输出 multipart/mixed。
	 * attachments 每项：{ filename, mimeType, disposition, contentId, base64 }
	 */
	buildRawMessage({ fromEmail, fromName, toEmail, toName, subject, html, text, messageId, attachments }) {

		const CRLF = '\r\n';

		const b64 = (s) => {
			const bytes = new TextEncoder().encode(s || '');
			let bin = '';
			for (let i = 0; i < bytes.length; i += 0x8000) {
				bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
			}
			return btoa(bin);
		};

		// 76 字符折行：用循环而不是正则，避免大附件时生成海量匹配对象
		const wrap = (s) => {
			const out = [];
			for (let i = 0; i < s.length; i += 76) {
				out.push(s.slice(i, i + 76));
			}
			return out.join(CRLF);
		};

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

		const body = html || `<pre>${(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
		const atts = Array.isArray(attachments) ? attachments.filter(a => a && a.base64) : [];

		if (atts.length === 0) {
			lines.push('Content-Type: text/html; charset=UTF-8');
			lines.push('Content-Transfer-Encoding: base64');
			return new TextEncoder().encode(lines.join(CRLF) + CRLF + CRLF + wrap(b64(body)) + CRLF);
		}

		const boundary = '----=_CM_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
		lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
		lines.push('');
		lines.push('--' + boundary);
		lines.push('Content-Type: text/html; charset=UTF-8');
		lines.push('Content-Transfer-Encoding: base64');
		lines.push('');
		lines.push(wrap(b64(body)));

		for (const a of atts) {
			const fn = hdr(a.filename || 'attachment');
			lines.push('');
			lines.push('--' + boundary);
			lines.push(`Content-Type: ${a.mimeType || 'application/octet-stream'}; name="${fn}"`);
			lines.push('Content-Transfer-Encoding: base64');
			lines.push(`Content-Disposition: ${a.disposition || 'attachment'}; filename="${fn}"`);
			if (a.contentId) {
				lines.push(`Content-ID: <${a.contentId}>`);
			}
			lines.push('');
			lines.push(wrap(a.base64));
		}

		lines.push('');
		lines.push('--' + boundary + '--');

		return new TextEncoder().encode(lines.join(CRLF) + CRLF);
	}
};

export default imapSyncService;
