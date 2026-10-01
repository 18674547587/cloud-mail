import orm from '../entity/orm';
import { att } from '../entity/att';
import { and, eq, isNull, inArray, desc } from 'drizzle-orm';
import r2Service from './r2-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { attConst } from '../const/entity-const';
import { parseHTML } from 'linkedom';
import { v4 as uuidv4 } from 'uuid';
import domainUtils from '../utils/domain-uitls';
import settingService from "./setting-service";
import s3Service from './s3-service';
import KvConst from '../const/kv-const';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

// 单个附件体积上限（直传模式，文件不经过 Worker，可以放得很宽）
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;

const attService = {

	// 申请附件直传凭证：前端拿到 uploadUrl 后直接 PUT 到对象存储
	async presign(c, params, userId) {

		const { filename, size, contentType } = params;

		if (!filename) {
			throw new BizError(t('attFilenameEmpty'));
		}

		const storageType = await r2Service.storageType(c);

		if (storageType !== 'S3') {
			throw new BizError(t('noPresignStorage'));
		}

		const fileSize = Number(size);

		if (!fileSize || fileSize <= 0) {
			throw new BizError(t('attSizeInvalid'));
		}

		if (fileSize > MAX_UPLOAD_SIZE) {
			throw new BizError(t('attTooLarge'));
		}

		const mimeType = contentType || 'application/octet-stream';

		// 直传时后端拿不到文件内容，无法用内容哈希命名，改用随机名
		const key = constant.ATTACHMENT_PREFIX + uuidv4().replace(/-/g, '') + fileUtils.getExtFileName(filename);

		// 记录归属，发送时校验；24 小时未被使用则自动过期（同时成为孤儿文件清理的依据）
		await c.env.kv.put(KvConst.ATT_UPLOAD + key, JSON.stringify({
			userId,
			filename,
			size: fileSize,
			contentType: mimeType
		}), { expirationTtl: 60 * 60 * 24 });

		const uploadUrl = await s3Service.presignPut(c, key, mimeType);

		return {
			key,
			uploadUrl,
			headers: { 'Content-Type': mimeType }
		};
	},

	// 校验直传的附件确实存在、且属于当前用户
	async verifyUpload(c, key, userId) {

		const record = await c.env.kv.get(KvConst.ATT_UPLOAD + key, { type: 'json' });

		if (record) {
			if (record.userId !== userId) {
				throw new BizError(t('attUploadNotOwner'), 403);
			}
			return record;
		}

		// 记录可能已过期，退化为只确认对象存在
		const head = await s3Service.headObj(c, key);

		if (!head) {
			throw new BizError(t('attUploadNotFound'));
		}

		return { size: head.size, contentType: head.contentType };
	},

	async addAtt(c, attachments) {

		for (let attachment of attachments) {

			let metadate = {
				contentType: attachment.mimeType,
			}

			if (!attachment.contentId) {
				metadate.contentDisposition = fileUtils.contentDisposition(attachment.filename, false)
			} else {
				metadate.contentDisposition = fileUtils.contentDisposition(attachment.filename, true)
				metadate.cacheControl = `max-age=259200`
			}

			await r2Service.putObj(c, attachment.key, attachment.content, metadate);

		}

		await orm(c).insert(att).values(attachments).run();
	},

	list(c, params, userId) {
		const { emailId } = params;

		return orm(c).select().from(att).where(
			and(
				eq(att.emailId, emailId),
				eq(att.userId, userId),
				eq(att.type, attConst.type.ATT),
				isNull(att.contentId)
			)
		).all();
	},

	async toImageUrlHtml(c, content) {

		const { r2Domain } = await settingService.query(c);

		const ossDomain = domainUtils.toOssDomain(r2Domain);

		const { document } = parseHTML(content);

		const images = Array.from(document.querySelectorAll('img'));

		let imageDataList = [];

		for (const img of images) {

			//邮件正文base64图片转cid附件
			const src = img.getAttribute('src');
			if (src && src.startsWith('data:image')) {
				const file = fileUtils.base64ToFile(src);
				const buff = await file.arrayBuffer();
				const cid = uuidv4().replace(/-/g, '');
				const key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(buff) + fileUtils.getExtFileName(file.name);

				img.setAttribute('src', 'cid:' + cid);

				const attData = {};
				attData.key = key;
				attData.filename = file.name;
				attData.mimeType = file.type;
				attData.size = file.size;
				attData.buff = buff;
				attData.content = fileUtils.base64ToDataStr(src);
				attData.contentId = cid;

				imageDataList.push(attData);
			}

			//邮件正文站内图片转cid附件
			if (src && ((ossDomain && src.startsWith(ossDomain)) || src.startsWith('attachments/'))) {

				const cid = uuidv4().replace(/-/g, '')
				img.setAttribute('src', 'cid:' + cid);

				const attData = {};

				if (ossDomain && src.startsWith(ossDomain)) {
					attData.key = src.replace(ossDomain + '/','');
					attData.path = src;
				}

				if (src.startsWith('attachments/')) {
					const origin = new URL(c.req.url).origin;
					attData.key = src;
					attData.path = origin + '/' + src;
				}

				attData.contentId = cid;
				attData.type = attConst.type.EMBED;
				imageDataList.push(attData);

			}

			const hasInlineWidth = img.hasAttribute('width');
			const style = img.getAttribute('style') || '';
			const hasStyleWidth = /(^|\s)width\s*:\s*[^;]+/.test(style);

			if (!hasInlineWidth && !hasStyleWidth) {
				const newStyle = (style ? style.trim().replace(/;$/, '') + '; ' : '') + 'max-width: 100%;';
				img.setAttribute('style', newStyle);
			}
		}

		//查询已有内嵌url图片信息
		const keys = [...new Set(imageDataList.filter(item => item.path).map(item => item.key))];
		const dbImageList  = await this.selectOneByKeys(c, keys);

		//设置给当前附件
		imageDataList.forEach(image => {
			dbImageList.forEach(dbImage => {
				if (image.path && (image.key === dbImage.key)) {
					image.size = dbImage.size;
					image.filename = dbImage.filename;
					image.mimeType = dbImage.mimeType;
					image.contentType = dbImage.mimeType;
				}
			})
		})

		imageDataList = imageDataList.filter(image => !image.path || image.size);

		return { imageDataList, html: document.toString() };
	},

	async saveSendAtt(c, attList, userId, accountId, emailId) {

		const attDataList = [];
		const inlineUploadList = [];

		for (let att of attList) {

			let key, size, mimeType;

			if (att.key) {

				// 直传模式：文件已由前端直接上传到对象存储，这里只校验归属并落库
				const record = await this.verifyUpload(c, att.key, userId);

				key = att.key;
				size = Number(att.size) || record?.size || 0;
				mimeType = att.contentType || record?.contentType || 'application/octet-stream';

			} else {

				// 兼容内联 base64 模式
				const buff = fileUtils.base64ToUint8Array(att.content);
				key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(buff) + fileUtils.getExtFileName(att.filename);
				size = buff.length;
				mimeType = att.contentType || att.type || 'application/octet-stream';
				inlineUploadList.push({ key, buff, filename: att.filename, mimeType });
			}

			attDataList.push({
				userId,
				accountId,
				emailId,
				key,
				size,
				filename: att.filename,
				mimeType,
				type: attConst.type.ATT
			});
		}

		await orm(c).insert(att).values(attDataList).run();

		for (let item of inlineUploadList) {
			await r2Service.putObj(c, item.key, item.buff, {
				contentType: item.mimeType,
				contentDisposition: fileUtils.contentDisposition(item.filename, false)
			});
		}

	},

	async saveArticleAtt(c, attDataList, userId, accountId, emailId) {

		for (let attData of attDataList) {
			attData.userId = userId;
			attData.emailId = emailId;
			attData.accountId = accountId;
			attData.type = attConst.type.EMBED;
			if (!attData.buff) {
				continue;
			}
			await r2Service.putObj(c, attData.key, attData.buff, {
				contentType: attData.mimeType,
				cacheControl: `max-age=259200`,
				contentDisposition: fileUtils.contentDisposition(attData.filename, true)
			});
			delete attData.buff;
		}

		await orm(c).insert(att).values(attDataList).run();

	},

	async removeByUserIds(c, userIds) {
		await this.removeAttByField(c, 'user_id', userIds);
	},

	async removeByEmailIds(c, emailIds) {
		await this.removeAttByField(c, 'email_id', emailIds);
	},

	selectByEmailIds(c, emailIds) {
		return orm(c).select().from(att).where(
			and(
				inArray(att.emailId, emailIds),
				eq(att.type, attConst.type.ATT)
			))
			.all();
	},

	async removeAttByField(c, fieldName, fieldValues) {

		const sqlList = [];

		fieldValues.forEach(value => {

			sqlList.push(

				c.env.db.prepare(
					`SELECT a.key, a.att_id
						FROM attachments a
							   JOIN (SELECT key
									 FROM attachments
									 GROUP BY key
									 HAVING COUNT (*) = 1) t
									ON a.key = t.key
						WHERE a.${fieldName} = ?;`
					).bind(value)
			)

			sqlList.push(c.env.db.prepare(`DELETE FROM attachments WHERE ${fieldName} = ?`).bind(value))

		});

		const attListResult = await c.env.db.batch(sqlList);

		const delKeyList = attListResult.flatMap(r => r.results ? r.results.map(row => row.key) : []);

		if (delKeyList.length > 0) {
			await this.batchDelete(c, delKeyList);
		}

	},

	async batchDelete(c, keys) {
		if (!keys.length) return;

		const BATCH_SIZE = 1000;

		for (let i = 0; i < keys.length; i += BATCH_SIZE) {
			const batch = keys.slice(i, i + BATCH_SIZE);
			await r2Service.delete(c, batch);
		}

	},

	// 清理「上传了但从未发送」的孤儿附件：
	// 直传模式下文件先落存储、发送时才落库，用户中途放弃就会留下无引用的对象
	// 通过 KV 游标分批扫描，避免每次都只检查最前面的一批
	async clearOrphan(c, maxScan = 1000, expireHours = 24) {

		const storageType = await r2Service.storageType(c);

		if (storageType !== 'S3') {
			return 0;
		}

		const cursor = await c.env.kv.get(KvConst.ATT_SCAN_CURSOR) || undefined;

		const list = await s3Service.listKeys(c, constant.ATTACHMENT_PREFIX, maxScan, cursor);

		if (list.length === 0) {
			await c.env.kv.delete(KvConst.ATT_SCAN_CURSOR);
			return 0;
		}

		// 本批未取满说明已扫到末尾，下一轮从头开始
		if (list.length < maxScan) {
			await c.env.kv.delete(KvConst.ATT_SCAN_CURSOR);
		} else {
			await c.env.kv.put(KvConst.ATT_SCAN_CURSOR, list[list.length - 1].key);
		}

		const expireTime = Date.now() - expireHours * 60 * 60 * 1000;

		// 只处理超过保留期的对象，避免误删正在上传或刚上传待发送的文件
		const candidates = list.filter(item => new Date(item.lastModified).getTime() < expireTime);

		if (candidates.length === 0) {
			return 0;
		}

		const existRows = await orm(c).select().from(att)
			.where(inArray(att.key, candidates.map(item => item.key)))
			.all();

		const existKeys = new Set(existRows.map(row => row.key));

		const delKeys = candidates.filter(item => !existKeys.has(item.key)).map(item => item.key);

		if (delKeys.length === 0) {
			return 0;
		}

		await this.batchDelete(c, delKeys);

		return delKeys.length;
	},

	async removeByAccountId(c, accountId) {
		await this.removeAttByField(c, "account_id", [accountId])
	},

	selectOneByKeys(c, keys) {
		if (!keys || keys.length === 0) {
			return []
		}
		return orm(c).select().from(att).where(inArray(att.key, keys)).orderBy(desc(att.attId)).groupBy(att.key).all();
	}
};

export default attService;
