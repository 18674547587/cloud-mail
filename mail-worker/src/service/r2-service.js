import s3Service from './s3-service';
import settingService from './setting-service';
import kvObjService from './kv-obj-service';

const r2Service = {

	async storageType(c) {

		const setting = await settingService.query(c);
		const { bucket, endpoint, s3AccessKey, s3SecretKey } = setting;

		if (!!(bucket && endpoint && s3AccessKey && s3SecretKey)) {
			return 'S3';
		}

		if (c.env.r2) {
			return 'R2';
		}

		return 'KV';
	},

	async putObj(c, key, content, metadata) {

		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			await kvObjService.putObj(c, key, content, metadata);
		}

		if (storageType === 'R2') {
			await c.env.r2.put(key, content, {
				httpMetadata: { ...metadata }
			});
		}

		if (storageType === 'S3') {
			await s3Service.putObj(c, key, content, metadata);
		}

	},

	async toObjResp(c, key) {

		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			return await kvObjService.toObjResp(c, key);
		}

		if (storageType === 'S3') {
			return await s3Service.toObjResp(c, key);
		}

		// R2
		if (!c.env.r2) {
			return new Response('Object storage not configured', { status: 404 });
		}

		const obj = await c.env.r2.get(key);

		if (!obj) {
			return new Response('Not Found', { status: 404 });
		}

		const headers = {};

		if (obj.httpMetadata?.contentType) {
			headers['Content-Type'] = obj.httpMetadata.contentType;
		}

		if (obj.httpMetadata?.contentDisposition) {
			headers['Content-Disposition'] = obj.httpMetadata.contentDisposition;
		}

		if (obj.httpMetadata?.cacheControl) {
			headers['Cache-Control'] = obj.httpMetadata.cacheControl;
		}

		return new Response(obj.body, { headers });
	},

	async delete(c, key) {

		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			await kvObjService.deleteObj(c, key);
		}

		if (storageType === 'R2') {
			await c.env.r2.delete(key);
		}

		if (storageType === 'S3'){
			await s3Service.deleteObj(c, key);
		}

	}

};
export default r2Service;
