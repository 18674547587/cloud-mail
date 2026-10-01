import orm from '../entity/orm';
import email from '../entity/email';
import { attConst, emailConst, isDel, settingConst } from '../const/entity-const';
import { and, desc, eq, gt, inArray, lt, count, asc, sql, ne, or, like, lte, gte } from 'drizzle-orm';
import { star } from '../entity/star';
import settingService from './setting-service';
import accountService from './account-service';
import BizError from '../error/biz-error';
import emailUtils from '../utils/email-utils';
import { Resend } from 'resend';
import attService from './att-service';
import { parseHTML } from 'linkedom';
import userService from './user-service';
import roleService from './role-service';
import user from '../entity/user';
import starService from './star-service';
import dayjs from 'dayjs';
import kvConst from '../const/kv-const';
import { t } from '../i18n/i18n'
import domainUtils from '../utils/domain-uitls';
import account from "../entity/account";
import { att } from '../entity/att';
import telegramService from './telegram-service';
import fileUtils from '../utils/file-utils';

// 附件体积上限（与前端 mail-vue/src/layout/write/index.vue 中的校验保持一致）
// 依据：附件需经 base64 编码后整体进内存，解码时内存峰值约为文件体积的 3~4 倍，
// 过大附件会触发 Worker 内存/CPU 超限，或超过 Resend 的单封邮件体积上限
const MAX_ATT_SIZE = 10 * 1024 * 1024;
const MAX_ATT_TOTAL_SIZE = 20 * 1024 * 1024;

// 站外发信时，附件总体积超过该阈值就改为「下载链接」：
// Resend 单封邮件上限 40MB（附件 base64 后计），Gmail 等收件方上限约 25MB，大文件当附件必然投递失败
const OUTBOUND_ATTACHMENT_LIMIT = 15 * 1024 * 1024;

// 分别发送（每个收件人单独一封）时，带附件的场景只能逐封调用 Resend API
// （Resend 的 batch 接口不支持 attachments），而 Worker 单次请求的子请求数量有限
// （免费计划 50 个），故对「分别发送 + 附件」的人数做限制
const DIVIDE_ATTACH_MAX = 20;

// Resend 回调的状态优先级：数值越大越接近"终态"
// 用途：webhook 不保证顺序且失败会重试，需防止「已投递」被迟到的 delivery_delayed 回退
const RESEND_STATUS_RANK = {
	[emailConst.status.SENT]: 0,
	[emailConst.status.DELAYED]: 1,
	[emailConst.status.DELIVERED]: 2,
	[emailConst.status.FAILED]: 3,
	[emailConst.status.COMPLAINED]: 3,
	[emailConst.status.BOUNCED]: 3
};

const emailService = {

	async list(c, params, userId) {

		let { emailId, type, accountId, size, timeSort, allReceive } = params;

		size = Number(size);
		emailId = Number(emailId);
		timeSort = Number(timeSort);
		accountId = Number(accountId);
		allReceive = Number(allReceive);

		if (size > 50) {
			size = 50;
		}

		if (!emailId) {

			if (timeSort) {
				emailId = 0;
			} else {
				emailId = 9999999999;
			}

		}

		if (isNaN(allReceive)) {
			let accountRow = await accountService.selectById(c, accountId);
			allReceive = accountRow.allReceive;
		}

		const query = orm(c)
			.select({
				...email,
				starId: star.starId
			})
			.from(email)
			.leftJoin(
				star,
				and(
					eq(star.emailId, email.emailId),
					eq(star.userId, userId)
				)
			).leftJoin(
				account,
				eq(account.accountId, email.accountId)
			)
			.where(
				and(
					allReceive ? eq(1,1) : eq(email.accountId, accountId),
					eq(email.userId, userId),
					timeSort ? gt(email.emailId, emailId) : lt(email.emailId, emailId),
					eq(email.type, type),
					eq(email.isDel, isDel.NORMAL),
					eq(account.isDel, isDel.NORMAL)
				)
			);

		if (timeSort) {
			query.orderBy(asc(email.emailId));
		} else {
			query.orderBy(desc(email.emailId));
		}

		const listQuery = query.limit(size).all();

		const totalQuery = orm(c).select({ total: count() }).from(email)
			.leftJoin(
				account,
				eq(account.accountId, email.accountId)
			)
			.where(
				and(
					allReceive ? eq(1,1) : eq(email.accountId, accountId),
					eq(email.userId, userId),
					eq(email.type, type),
					eq(email.isDel, isDel.NORMAL),
					eq(account.isDel, isDel.NORMAL)
				)
		).get();

		const latestEmailQuery = orm(c).select().from(email).where(
			and(
				allReceive ? eq(1,1) : eq(email.accountId, accountId),
				eq(email.userId, userId),
				eq(email.type, type),
				eq(email.isDel, isDel.NORMAL)
			))
			.orderBy(desc(email.emailId)).limit(1).get();

		let [list, totalRow, latestEmail] = await Promise.all([listQuery, totalQuery, latestEmailQuery]);

		list = list.map(item => ({
			...item,
			isStar: item.starId != null ? 1 : 0
		}));


		await this.emailAddAtt(c, list);

		if (!latestEmail) {
			latestEmail = {
				emailId: 0,
				accountId: accountId,
				userId: userId,
			}
		}

		return { list, total: totalRow.total, latestEmail };
	},

	async delete(c, params, userId) {
		const { emailIds } = params;
		const emailIdList = emailIds.split(',').map(Number);
		await orm(c).update(email).set({ isDel: isDel.DELETE }).where(
			and(
				eq(email.userId, userId),
				inArray(email.emailId, emailIdList)))
			.run();
	},

	receive(c, params, cidAttList, r2domain) {
		params.content = this.imgReplace(params.content, cidAttList, r2domain)
		return orm(c).insert(email).values({ ...params }).returning().get();
	},

	//邮件发送
	async send(c, params, userId) {

		let {
			accountId, //发送账号id
			name, //发件人名字
			sendType, //发件类型
			emailId, //邮件id，如果是回复邮件会带
			receiveEmail, //收件人邮箱
			manyType, //发件方式：'divide' 为分别发送（每个收件人单独一封，互相看不到邮箱）
			text, //邮件纯文本
			content, //邮件内容
			subject, //邮件标题
			attachments //附件
		} = params;

		const { resendTokens, r2Domain, send, domainList } = await settingService.query(c);

		// 正文内嵌图片数量预检：避免在 toImageUrlHtml 的解码阶段才发现超限（那时内存已经吃掉了）
		const inlineImageCount = (content?.match(/data:image\//gi) || []).length;
		if (inlineImageCount > 10) {
			throw new BizError(t('imageAttLimit'));
		}

		let { imageDataList, html } = await attService.toImageUrlHtml(c, content);

		// 附件/正文图片的校验必须前置：
		// 原实现放在 resend.emails.send() 和入库之后，会导致邮件已经发出、附件却没保存，
		// 用户却收到"发送失败"的提示；同时超大附件会直接撑爆 Worker 内存（整包 base64 进内存）
		if (imageDataList.length > 10) {
			throw new BizError(t('imageAttLimit'));
		}

		if (imageDataList.length > 0) {
			const inlineTotalSize = imageDataList.reduce((sum, item) => sum + (item.size || 0), 0);
			if (inlineTotalSize > MAX_ATT_TOTAL_SIZE) {
				throw new BizError(t('attTotalSizeLimit'));
			}
		}

		if (attachments?.length > 10) {
			throw new BizError(t('attLimit'));
		}

		if (attachments?.length > 0) {
			let totalInlineSize = 0;
			for (let att of attachments) {
				// 直传模式的附件不经过 Worker 内存，体积由 /att/presign 单独限制
				if (att.key) {
					continue;
				}
				// size 由前端提供，可能缺失或被伪造，这里用 base64 长度兜底估算
				const attSize = Number(att.size) || Math.floor((att.content?.length || 0) * 3 / 4);
				if (attSize > MAX_ATT_SIZE) {
					throw new BizError(t('attSizeLimit'));
				}
				totalInlineSize += attSize;
			}
			if (totalInlineSize > MAX_ATT_TOTAL_SIZE) {
				throw new BizError(t('attTotalSizeLimit'));
			}
		}

		//判断是否关闭发件功能
		if (send === settingConst.send.CLOSE) {
			throw new BizError(t('disabledSend'), 403);
		}

		const userRow = await userService.selectById(c, userId);
		const roleRow = await roleService.selectById(c, userRow.type);

		//判断接收方是不是全部为站内邮箱
		const allInternal = receiveEmail.every(email => {
			const domain = '@' + emailUtils.getDomain(email);
			return domainList.includes(domain);
		});

		if (c.env.admin !== userRow.email) {

			//发件被禁用
			if (roleRow.sendType === 'ban') {
				throw new BizError(t('bannedSend'), 403);
			}

			//发件被禁用
			if (roleRow.sendType === 'internal' && !allInternal) {
				throw new BizError(t('onlyInternalSend'), 403);
			}

		}

		//如果不是管理员，权限设置了发送次数
		if (c.env.admin !== userRow.email && roleRow.sendCount) {

			if (userRow.sendCount >= roleRow.sendCount) {
				if (roleRow.sendType === 'day') throw new BizError(t('daySendLimit'), 403);
				if (roleRow.sendType === 'count') throw new BizError(t('totalSendLimit'), 403);
			}

			if (userRow.sendCount + receiveEmail.length > roleRow.sendCount) {
				if (roleRow.sendType === 'day') throw new BizError(t('daySendLack'), 403);
				if (roleRow.sendType === 'count') throw new BizError(t('totalSendLack'), 403);
			}

		}

		const accountRow = await accountService.selectById(c, accountId);

		if (!accountRow) {
			throw new BizError(t('senderAccountNotExist'));
		}

		if (accountRow.userId !== userId) {
			throw new BizError(t('sendEmailNotCurUser'));
		}

		if (c.env.admin !== userRow.email) {
			//用户没有这个域名的使用权限
			if(!roleService.hasAvailDomainPerm(roleRow.availDomain, accountRow.email)) {
				throw new BizError(t('noDomainPermSend'),403)
			}

		}

		const domain = emailUtils.getDomain(accountRow.email);
		const resendToken = resendTokens[domain];

		//如果接收方存在站外邮箱，又没有resend token
		if (!resendToken && !allInternal) {
			throw new BizError(t('noResendToken'));
		}

		//没有发件人名字自动截取
		if (!name) {
			name = emailUtils.getName(accountRow.email);
		}

		let emailRow = {
			messageId: null
		};

		//如果是回复邮件
		if (sendType === 'reply') {

			emailRow = await this.selectById(c, emailId);

			if (!emailRow) {
				throw new BizError(t('notExistEmailReply'));
			}

		}

		// 分别发送：每个收件人单独一封，收件人之间互相看不到对方邮箱
		// 只有一个收件人时与合并发送完全等价，无需拆分
		const isDivide = manyType === 'divide' && receiveEmail.length > 1;

		let resendResult = {};

		// 分别发送时逐封发送的结果，顺序与 receiveEmail 一致
		const divideResults = [];
		const divideFailures = [];

		//存在站外时邮箱全部由resend发送
		if (!allInternal) {

			const origin = new URL(c.req.url).origin;

			// 附件总体积超阈值时改为下载链接：大文件作为附件在邮件协议层面投递不出去
			let outboundAttachments = attachments || [];

			const outboundAttSize = outboundAttachments.reduce((sum, item) => sum + (Number(item.size) || 0), 0);

			if (outboundAttachments.length > 0 && outboundAttSize > OUTBOUND_ATTACHMENT_LIMIT) {
				html = this.appendDownloadLinks(html, outboundAttachments, origin);
				outboundAttachments = [];
			}

			const resend = new Resend(resendToken);

			const resendAttachments = [...imageDataList, ...this.toResendAttachments(outboundAttachments, origin)];

			// to 只放传入的收件人：合并发送传全部，分别发送每次只传一个
			const buildSendForm = (toList) => {

				const form = {
					from: `${name} <${accountRow.email}>`,
					to: toList,
					subject: subject,
					text: text,
					html: html,
					attachments: resendAttachments
				};

				if (sendType === 'reply') {
					form.headers = {
						'in-reply-to': emailRow.messageId,
						'references': emailRow.messageId
					};
				}

				return form;

			};

			if (isDivide) {

				if (resendAttachments.length > 0) {

					// Resend 的 batch 接口不支持 attachments，只能逐封单发；
					// 逐封单发会消耗与人数等量的子请求，故限制单次人数
					if (receiveEmail.length > DIVIDE_ATTACH_MAX) {
						throw new BizError(t('divideAttLimit', { count: DIVIDE_ATTACH_MAX }));
					}

					for (const item of receiveEmail) {

						const singleResult = await resend.emails.send(buildSendForm([item]));

						if (singleResult.error) {
							divideFailures.push({ email: item, message: singleResult.error.message });
							continue;
						}

						divideResults.push({ email: item, resendEmailId: singleResult.data?.id });

					}

				} else {

					// 无附件时用 batch：不论多少收件人都只占 1 个子请求，避免 Worker 子请求数超限
					for (let i = 0; i < receiveEmail.length; i += 100) {

						const batchList = receiveEmail.slice(i, i + 100);

						const batchResult = await resend.batch.send(batchList.map(item => buildSendForm([item])));

						if (batchResult.error) {
							divideFailures.push({ email: batchList.join(', '), message: batchResult.error.message });
							continue;
						}

						// batch 返回的 id 顺序与请求顺序一致
						const batchData = batchResult.data?.data || batchResult.data || [];

						batchList.forEach((item, index) => {
							divideResults.push({ email: item, resendEmailId: batchData[index]?.id });
						});

					}

				}

			} else {

				resendResult = await resend.emails.send(buildSendForm([...receiveEmail]));

			}

		}

		const { data, error } = resendResult;


		if (!isDivide && error) {
			throw new BizError(error.message);
		}

		imageDataList = imageDataList.map(item => ({...item, contentId: `<${item.contentId}>`}))

		//把图片标签cid标签切换会通用url
		html = this.imgReplace(html, imageDataList, r2Domain);

		//封装数据保存到数据库
		// recipient 只记录本条记录对应的收件人：分别发送时每封只写自己，
		// 避免收件人在邮件详情页看到其他收件人的邮箱
		const buildEmailData = (toList, resendEmailId) => {

			const emailData = {};
			emailData.sendEmail = accountRow.email;
			emailData.name = name;
			emailData.subject = subject;
			emailData.content = html;
			emailData.text = text;
			emailData.accountId = accountId;
			emailData.status = emailConst.status.SENT;
			emailData.type = emailConst.type.SEND;
			emailData.userId = userId;
			emailData.resendEmailId = resendEmailId;
			emailData.recipient = JSON.stringify(toList.map(item => ({ address: item, name: '' })));

			if (sendType === 'reply') {
				emailData.inReplyTo = emailRow.messageId;
				emailData.relation = emailRow.messageId;
			}

			return emailData;

		};

		// 分别发送（站外）时每个收件人单独一条已发送记录，recipient 只含自己
		const emailDataList = (isDivide && !allInternal)
			? divideResults.map(item => buildEmailData([item.email], item.resendEmailId))
			: [ buildEmailData(receiveEmail, data?.id) ];

		//如果权限有发送次数增加用户发送次数
		if (roleRow.sendCount && roleRow.sendType !== 'internal') {
			await userService.incrUserSendCount(c, receiveEmail.length, userId);
		}

		//保存到数据库并返回结果
		const emailResultList = [];
		let firstAttList = [];

		for (const emailData of emailDataList) {

			const emailResult = await orm(c).insert(email).values(emailData).returning().get();

			//保存内嵌附件（数量已在发送前校验）
			if (imageDataList.length > 0) {
				await attService.saveArticleAtt(c, imageDataList, userId, accountId, emailResult.emailId);
			}

			//保存普通附件（数量/体积已在发送前校验）
			if (attachments?.length > 0) {
				await attService.saveSendAtt(c, attachments, userId, accountId, emailResult.emailId);
			}

			const attList = await attService.selectByEmailIds(c, [emailResult.emailId]);
			emailResult.attList = attList;

			if (emailResultList.length === 0) {
				firstAttList = attList;
			}

			emailResultList.push(emailResult);

		}

		//如果全是站内接收方，直接写入数据库
		if (allInternal) {
			await this.HandleOnSiteEmail(c, receiveEmail, emailResultList[0], firstAttList, isDivide);
		}

		const dateStr = dayjs().format('YYYY-MM-DD');
		let daySendTotal = await c.env.kv.get(kvConst.SEND_DAY_COUNT + dateStr);

		//记录每天发件次数统计
		if (!daySendTotal) {
			await c.env.kv.put(kvConst.SEND_DAY_COUNT + dateStr, JSON.stringify(receiveEmail.length), { expirationTtl: 60 * 60 * 24 });
		} else  {
			daySendTotal = Number(daySendTotal) + receiveEmail.length
			await c.env.kv.put(kvConst.SEND_DAY_COUNT + dateStr, JSON.stringify(daySendTotal), { expirationTtl: 60 * 60 * 24 });
		}

		// 分别发送时若有个别收件人发送失败：已成功的记录已经入库，这里统一抛出提示
		if (divideFailures.length > 0) {
			throw new BizError(t('divideSendPartial', {
				success: divideResults.length,
				emails: divideFailures.map(item => item.email).join(', ')
			}));
		}

		return emailResultList;
	},

	//处理站内邮件发送
	async HandleOnSiteEmail(c, receiveEmail, sendEmailData, attList, isDivide = false) {

		const { noRecipient  } = await settingService.query(c);

		//查询所有收件人账号信息
		let accountList = await orm(c).select().from(account).where(inArray(account.email, receiveEmail)).all();

		//查询所有收件人权限身份
		const userIds = accountList.map(accountRow => accountRow.userId);
		let roleList = await roleService.selectByUserIds(c, userIds);

		//封装数据库准备保存到数据库
		const emailDataList = [];

		for (const email of receiveEmail) {

			//把发件人邮件改成收件
			const emailValues = {...sendEmailData}
			emailValues.status = emailConst.status.RECEIVE;
			emailValues.type = emailConst.type.RECEIVE;
			emailValues.toEmail = email;
			emailValues.toName = emailUtils.getName(email);
			emailValues.emailId = null;

			// 分别发送时，收件记录只保留自己的地址，
			// 避免站内收件人在详情页看到其他收件人的邮箱
			if (isDivide) {
				emailValues.recipient = JSON.stringify([{ address: email, name: '' }]);
			}

			const accountRow = accountList.find(accountRow => accountRow.email === email);

			//如果收件人存在就把邮件信息改成收件人的
			if (accountRow) {

				//设置给收件人保存
				emailValues.userId = accountRow.userId;
				emailValues.accountId = accountRow.accountId;
				emailValues.type = emailConst.type.RECEIVE;
				emailValues.status = emailConst.status.RECEIVE;

				const roleRow = roleList.find(roleRow => roleRow.userId === accountRow.userId);

				let { banEmail, availDomain } = roleRow;

				//如果收件人没有这个域名的使用权限和有邮件拦截，就把邮件改为拒收状态
				if (email !== c.env.admin) {

					if (!roleService.hasAvailDomainPerm(availDomain, email)) {
						emailValues.status = emailConst.status.BOUNCED;
						emailValues.message = `The recipient <${email}> is not authorized to use this domain.`;
					} else if(roleService.isBanEmail(banEmail, sendEmailData.sendEmail)) {
						emailValues.status = emailConst.status.BOUNCED;
						emailValues.message = `The recipient <${email}> is disabled from receiving emails.`;
					}

				}

				emailDataList.push(emailValues);

			} else {

				//设置无收件人邮件信息
				emailValues.userId = 0;
				emailValues.accountId = 0;
				emailValues.type = emailConst.type.RECEIVE;
				emailValues.status = emailConst.status.NOONE;

				//如果无人收件关闭改为拒收
				if (noRecipient === settingConst.noRecipient.CLOSE) {
					emailValues.status = emailConst.status.BOUNCED;
					emailValues.message = `Recipient not found: <${email}>`;
				}

				emailDataList.push(emailValues);

			}

		}

		//保存邮件
		const receiveEmailList = emailDataList.filter(emailRow => emailRow.status === emailConst.status.RECEIVE || emailRow.status === emailConst.status.NOONE);

		for (const emailData of receiveEmailList) {

			const emailRow = await orm(c).insert(email).values(emailData).returning().get();

			//设置附件保存
			for (const attRow of attList) {
				const attValues = {...attRow};
				attValues.emailId = emailRow.emailId;
				attValues.accountId = emailRow.accountId;
				attValues.userId = emailRow.userId;
				attValues.attId = null;
				await orm(c).insert(att).values(attValues).run();
			}

		}

		const bouncedEmail = emailDataList.find(emailRow => emailRow.status === emailConst.status.BOUNCED);


		let status = emailConst.status.DELIVERED;
		let message = ''
		//如果有拒收邮件，就把发件人的邮件改成拒收
		if (bouncedEmail) {
			const messageJson = { message: bouncedEmail.message };
			message = JSON.stringify(messageJson);
			status = emailConst.status.BOUNCED;
		}

		await orm(c).update(email).set({ status, message: message }).where(eq(email.emailId, sendEmailData.emailId)).run();

	},

	// 把直传的附件转成 Resend 可用的形式：用远程 URL 让它自行拉取，
	// 避免把整个文件塞进 API 请求体（那正是内存超限与 40MB 上限的来源）
	toResendAttachments(attachments, origin) {

		return (attachments || []).map(att => {

			if (att.key) {
				return {
					filename: att.filename,
					// key 已包含 attachments/ 前缀，直接拼在站点根路径后
					path: `${origin}/${att.key}`
				};
			}

			return {
				filename: att.filename,
				content: att.content
			};
		});
	},

	// 附件过大时，在正文末尾追加下载链接
	appendDownloadLinks(html, attachments, origin) {

		const escape = (str) => String(str || '').replace(/[<>&"]/g, s => ({
			'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;'
		}[s]));

		const items = (attachments || []).map(att => {
			// key 已包含 attachments/ 前缀
			const url = `${origin}/${att.key}`;
			return `<li><a href="${escape(url)}">${escape(att.filename)}</a>（${fileUtils.formatSize(att.size)}）</li>`;
		}).join('');

		const block = `
<div style="margin-top:16px;padding:12px;border:1px solid #e5e7eb;border-radius:6px;">
	<p style="margin:0 0 8px;font-weight:bold;">附件下载链接</p>
	<p style="margin:0 0 8px;color:#6b7280;font-size:12px;">文件较大，未作为附件发送，请点击下方链接下载。</p>
	<ul style="margin:0;padding-left:20px;">${items}</ul>
</div>`;

		return (html || '') + block;
	},

	imgReplace(content, cidAttList, r2domain) {
		if (!content) {
			return ''
		}

		const { document } = parseHTML(content);

		const images = Array.from(document.querySelectorAll('img'));

		const useAtts = []

		for (const img of images) {

			const src = img.getAttribute('src');
			if (src && src.startsWith('cid:') && cidAttList) {

				const cid = src.replace(/^cid:/, '');
				const attCidIndex = cidAttList.findIndex(cidAtt => cidAtt.contentId.replace(/^<|>$/g, '') === cid);

				if (attCidIndex > -1) {
					const cidAtt = cidAttList[attCidIndex];
					img.setAttribute('src', '{{domain}}' + cidAtt.key);
					useAtts.push(cidAtt)
				}

			}

			r2domain = domainUtils.toOssDomain(r2domain)

			if (src && src.startsWith(r2domain + '/')) {
				img.setAttribute('src', src.replace(r2domain + '/', '{{domain}}'));
			}

		}

		useAtts.forEach(att => {
			att.type = attConst.type.EMBED
		})

		return document.toString();
	},

	selectById(c, emailId) {
		return orm(c).select().from(email).where(
			and(eq(email.emailId, emailId),
				eq(email.isDel, isDel.NORMAL)))
			.get();
	},

	async latest(c, params, userId) {
		let { emailId, accountId, allReceive } = params;
		allReceive = Number(allReceive);

		if (isNaN(allReceive)) {
			let accountRow = await accountService.selectById(c, accountId);
			allReceive = accountRow.allReceive;
		}

		let list = await orm(c).select({...email}).from(email)
			.leftJoin(
				account,
				eq(account.accountId, email.accountId)
			)
			.where(
				and(
					gt(email.emailId, emailId),
					eq(email.userId, userId),
					eq(email.isDel, isDel.NORMAL),
					eq(account.isDel, isDel.NORMAL),
					allReceive ? eq(1,1) : eq(email.accountId, accountId),
					eq(email.type, emailConst.type.RECEIVE)
				))
			.orderBy(desc(email.emailId))
			.limit(20);

		await this.emailAddAtt(c, list);

		return list;
	},

	async physicsDelete(c, params) {
		let { emailIds } = params;
		emailIds = emailIds.split(',').map(Number);
		await attService.removeByEmailIds(c, emailIds);
		await starService.removeByEmailIds(c, emailIds);
		await orm(c).delete(email).where(inArray(email.emailId, emailIds)).run();
	},

	async physicsDeleteUserIds(c, userIds) {
		await attService.removeByUserIds(c, userIds);
		await orm(c).delete(email).where(inArray(email.userId, userIds)).run();
	},

	async updateEmailStatus(c, params) {
		const { status, resendEmailId, message } = params;

		const current = await orm(c)
			.select({ status: email.status })
			.from(email)
			.where(eq(email.resendEmailId, resendEmailId))
			.get();

		if (!current) {
			return undefined;
		}

		// 状态优先级保护：只允许向更"终态"的方向流转，
		// 避免 webhook 乱序/重试把已投递的邮件回退成「投递延迟」等早期状态
		const currentRank = RESEND_STATUS_RANK[current.status] ?? 0;
		const nextRank = RESEND_STATUS_RANK[status] ?? 0;

		if (nextRank < currentRank) {
			return current;
		}

		return orm(c).update(email).set({
			status: status,
			message: message
		}).where(eq(email.resendEmailId, resendEmailId)).returning().get();
	},

	async selectUserEmailCountList(c, userIds, type, del = isDel.NORMAL) {
		const result = await orm(c)
			.select({
				userId: email.userId,
				count: count(email.emailId)
			})
			.from(email)
			.where(and(
				inArray(email.userId, userIds),
				eq(email.type, type),
				eq(email.isDel, del),
				ne(email.status, emailConst.status.SAVING),
			))
			.groupBy(email.userId);
		return result;
	},

	async allList(c, params) {

		let { emailId, size, name, subject, accountEmail, userEmail, type, timeSort } = params;

		size = Number(size);

		emailId = Number(emailId);
		timeSort = Number(timeSort);

		if (size > 50) {
			size = 50;
		}

		if (!emailId) {

			if (timeSort) {
				emailId = 0;
			} else {
				emailId = 9999999999;
			}

		}

		const conditions = [];

		if (type === 'send') {
			conditions.push(eq(email.type, emailConst.type.SEND));
		}

		if (type === 'receive') {
			conditions.push(eq(email.type, emailConst.type.RECEIVE));
		}

		if (type === 'delete') {
			conditions.push(eq(email.isDel, isDel.DELETE));
		}

		if (type === 'noone') {
			conditions.push(eq(email.status, emailConst.status.NOONE));
		}

		if (userEmail) {
			conditions.push(sql`${user.email} COLLATE NOCASE LIKE ${'%'+ userEmail + '%'}`);
		}

		if (accountEmail) {
			conditions.push(
				or(
					sql`${email.toEmail} COLLATE NOCASE LIKE ${'%'+ accountEmail + '%'}`,
					sql`${email.sendEmail} COLLATE NOCASE LIKE ${'%'+ accountEmail + '%'}`,
				)
			)
		}

		if (name) {
			conditions.push(sql`${email.name} COLLATE NOCASE LIKE ${'%'+ name + '%'}`);
		}

		if (subject) {
			conditions.push(sql`${email.subject} COLLATE NOCASE LIKE ${'%'+ subject + '%'}`);
		}

		conditions.push(ne(email.status, emailConst.status.SAVING));

		const countConditions = [...conditions];

		if (timeSort) {
			conditions.unshift(gt(email.emailId, emailId));
		} else {
			conditions.unshift(lt(email.emailId, emailId));
		}

		const query = orm(c).select({ ...email, userEmail: user.email })
			.from(email)
			.leftJoin(user, eq(email.userId, user.userId))
			.where(and(...conditions));

		const queryCount = orm(c).select({ total: count() })
			.from(email)
			.leftJoin(user, eq(email.userId, user.userId))
			.where(and(...countConditions));

		if (timeSort) {
			query.orderBy(asc(email.emailId));
		} else {
			query.orderBy(desc(email.emailId));
		}

		const listQuery = await query.limit(size).all();
		const totalQuery = await queryCount.get();
		const latestEmailQuery = await orm(c).select().from(email)
			.where(and(
				eq(email.type, emailConst.type.RECEIVE),
				ne(email.status, emailConst.status.SAVING)
			))
			.orderBy(desc(email.emailId)).limit(1).get();

		let [list, totalRow, latestEmail] = await Promise.all([listQuery, totalQuery, latestEmailQuery]);

		await this.emailAddAtt(c, list);

		if (!latestEmail) {
			latestEmail = {
				emailId: 0,
				accountId: 0,
				userId: 0,
			}
		}

		return { list: list, total: totalRow.total, latestEmail };
	},

	async allEmailLatest(c, params) {

		const { emailId } = params;

		let list = await orm(c).select({...email, userEmail: user.email}).from(email)
			.leftJoin(user, eq(email.userId, user.userId))
			.where(
				and(
					gt(email.emailId, emailId),
					eq(email.type, emailConst.type.RECEIVE),
					ne(email.status, emailConst.status.SAVING)
				))
			.orderBy(desc(email.emailId))
			.limit(20);

		await this.emailAddAtt(c, list);

		return list;
	},

	async emailAddAtt(c, list) {

		const emailIds = list.map(item => item.emailId);

		if (emailIds.length > 0) {

			const attList = await attService.selectByEmailIds(c, emailIds);

			list.forEach(emailRow => {
				const atts = attList.filter(attRow => attRow.emailId === emailRow.emailId);
				emailRow.attList = atts;
			});
		}
	},

	async restoreByUserId(c, userId) {
		await orm(c).update(email).set({ isDel: isDel.NORMAL }).where(eq(email.userId, userId)).run();
	},

	async completeReceive(c, status, emailId) {
		return await orm(c).update(email).set({
			isDel: isDel.NORMAL,
			status: status
		}).where(eq(email.emailId, emailId)).returning().get();
	},

	async completeReceiveAll(c) {
		await c.env.db.prepare(`UPDATE email as e SET status = ${emailConst.status.RECEIVE} WHERE status = ${emailConst.status.SAVING} AND EXISTS (SELECT 1 FROM account WHERE account_id = e.account_id)`).run();
		await c.env.db.prepare(`UPDATE email as e SET status = ${emailConst.status.NOONE} WHERE status = ${emailConst.status.SAVING} AND NOT EXISTS (SELECT 1 FROM account WHERE account_id = e.account_id)`).run();
	},

	async batchDelete(c, params) {
		let { sendName, sendEmail, toEmail, subject, startTime, endTime, type  } = params

		let right = type === 'left' || type === 'include'
		let left = type === 'include'

		const conditions = []

		if (sendName) {
			conditions.push(like(email.name,`${left ? '%' : ''}${sendName}${right ? '%' : ''}`))
		}

		if (subject) {
			conditions.push(like(email.subject,`${left ? '%' : ''}${subject}${right ? '%' : ''}`))
		}

		if (sendEmail) {
			conditions.push(like(email.sendEmail,`${left ? '%' : ''}${sendEmail}${right ? '%' : ''}`))
		}

		if (toEmail) {
			conditions.push(like(email.toEmail,`${left ? '%' : ''}${toEmail}${right ? '%' : ''}`))
		}

		if (startTime && endTime) {
			conditions.push(gte(email.createTime,`${startTime}`))
			conditions.push(lte(email.createTime,`${endTime}`))
		}

		if (conditions.length === 0) {
			return;
		}

		const emailIdsRow = await orm(c).select({emailId: email.emailId}).from(email).where(conditions.length > 1 ? and(...conditions) : conditions[0]).all();

		const emailIds = emailIdsRow.map(row => row.emailId);

		if (emailIds.length === 0){
			return;
		}

		await attService.removeByEmailIds(c, emailIds);

		await orm(c).delete(email).where(conditions.length > 1 ? and(...conditions) : conditions[0]).run();
	},

	async physicsDeleteByAccountId(c, accountId) {
		await attService.removeByAccountId(c, accountId);
		await orm(c).delete(email).where(eq(email.accountId, accountId)).run();
	},

	async read(c, params, userId) {
		const { emailIds } = params;
		await orm(c).update(email).set({ unread: emailConst.unread.READ }).where(and(eq(email.userId, userId), inArray(email.emailId, emailIds)));
	}
};

export default emailService;
