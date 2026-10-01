import { S3Client, PutObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import settingService from './setting-service';
import domainUtils from '../utils/domain-uitls';
import { settingConst } from '../const/entity-const';
const s3Service = {

	// 生成前端直传用的预签名 PUT URL
	// 浏览器直接 PUT 到对象存储，文件不经过 Worker，因此不受 Worker 内存/请求体限制
	async presignPut(c, key, contentType, expiresIn = 900) {

		const client = await this.client(c);
		const { bucket } = await settingService.query(c);

		const command = new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			ContentType: contentType
		});

		return await getSignedUrl(client, command, { expiresIn });
	},

	// 列出指定前缀下的对象（用于孤儿文件清理），支持从游标继续
	async listKeys(c, prefix, maxKeys = 1000, startAfter) {

		const client = await this.client(c);
		const { bucket } = await settingService.query(c);

		const params = {
			Bucket: bucket,
			Prefix: prefix,
			MaxKeys: maxKeys
		};

		if (startAfter) {
			params.StartAfter = startAfter;
		}

		const res = await client.send(new ListObjectsV2Command(params));

		return (res.Contents || []).map(item => ({
			key: item.Key,
			lastModified: item.LastModified
		}));
	},

	// 检查对象是否存在（用于校验直传是否真的完成）
	async headObj(c, key) {

		const client = await this.client(c);
		const { bucket } = await settingService.query(c);

		try {
			const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
			return {
				size: res.ContentLength,
				contentType: res.ContentType
			};
		} catch (e) {
			return null;
		}
	},

	async putObj(c, key, content, metadata) {

		const client = await this.client(c);

		const { bucket } = await settingService.query(c);

		let obj = { Bucket: bucket, Key: key, Body: content,
			CacheControl: metadata.cacheControl
		}

		if (metadata.cacheControl) {
			obj.CacheControl = metadata.cacheControl
		}

		if (metadata.contentDisposition) {
			obj.ContentDisposition = metadata.contentDisposition
		}

		if (metadata.contentType) {
			obj.ContentType = metadata.contentType
		}

		await client.send(new PutObjectCommand(obj))
	},

	// 生成预签名 GET URL（内部读取对象用）
	// 走 fetch 而不是 SDK 的 GetObject，避免 SDK 响应处理在 Workers 环境下的兼容问题
	async presignGet(c, key, expiresIn = 300) {

		const client = await this.client(c);
		const { bucket } = await settingService.query(c);

		const command = new GetObjectCommand({
			Bucket: bucket,
			Key: key
		});

		return await getSignedUrl(client, command, { expiresIn });
	},

	async toObjResp(c, key) {

		let res;
		let url;

		try {
			url = await this.presignGet(c, key);
			res = await fetch(url);
		} catch (e) {
			return new Response('Object read failed: ' + (e?.message || e), { status: 502 });
		}

		if (!res.ok) {
			return new Response('Not Found', { status: 404 });
		}

		const headers = {};

		const contentType = res.headers.get('content-type');
		const contentDisposition = res.headers.get('content-disposition');
		const cacheControl = res.headers.get('cache-control');

		if (contentType) {
			headers['Content-Type'] = contentType;
		}

		if (contentDisposition) {
			headers['Content-Disposition'] = contentDisposition;
		}

		if (cacheControl) {
			headers['Cache-Control'] = cacheControl;
		}

		return new Response(res.body, { headers });
	},

	async deleteObj(c, keys) {

		if (typeof keys === 'string') {
			keys = [keys];
		}

		if (keys.length === 0) {
			return;
		}

		const client = await this.client(c);
		const { bucket } = await settingService.query(c);

		// 注意：不要手动设置 Content-MD5。
		// Workers 的 Web Crypto 不支持 MD5，原实现用 crypto.subtle.digest('MD5', ...) 必然抛错，
		// 导致对象永远删不掉（存储只增不减）。这里交给 SDK 自动计算 CRC32 校验和。
		await client.send(
			new DeleteObjectsCommand({
				Bucket: bucket,
				Delete: {
					Objects: keys.map(key => ({ Key: key }))
				}
			})
		);
	},


	async client(c) {
		const { region, endpoint, s3AccessKey, s3SecretKey, forcePathStyle } = await settingService.query(c);
		return new S3Client({
			region: region || 'auto',
			endpoint: domainUtils.toOssDomain(endpoint),
			forcePathStyle: forcePathStyle === settingConst.forcePathStyle.OPEN,
			credentials: {
				accessKeyId: s3AccessKey,
				secretAccessKey: s3SecretKey,
			}
		});
	}
}

export default s3Service
