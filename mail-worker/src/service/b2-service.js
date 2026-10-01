import { AwsClient } from 'aws4fetch';

/**
 * Backblaze B2 冷归档回源服务
 * ---------------------------------------------------------------
 * 附件被归档 Worker 搬到 B2 后，R2 中已不存在该对象。
 * 这里负责：查 D1 archive_index → 从 B2 流式取回 → 返回 Response。
 * 注意：只读，不回填 R2（按用户要求，避免重新占用 R2 空间）。
 */
const b2Service = {

	enabled(env) {
		return !!(env && env.B2_SECRET && env.B2_KEY_ID && env.B2_BUCKET && env.B2_ENDPOINT);
	},

	client(env) {
		return new AwsClient({
			accessKeyId: env.B2_KEY_ID,
			secretAccessKey: env.B2_SECRET,
			service: 's3',
			region: env.B2_REGION || 'us-west-004'
		});
	},

	encodeKey(key) {
		return String(key).split('/').map(encodeURIComponent).join('/');
	},

	/** 查询归档索引 */
	async lookup(env, key) {
		if (!env || !env.db) {
			return null;
		}
		try {
			return await env.db
				.prepare('SELECT r2_key, b2_key, size, md5, month FROM archive_index WHERE r2_key = ?')
				.bind(key)
				.first();
		} catch (e) {
			// 表不存在等情况，视为未归档
			return null;
		}
	},

	/**
	 * 尝试从 B2 回源读取
	 * @returns {Promise<Response|null>} null 表示未归档（调用方按 404 处理）
	 */
	async toObjResp(env, key) {

		if (!this.enabled(env)) {
			return null;
		}

		const row = await this.lookup(env, key);

		if (!row || !row.b2_key) {
			return null;
		}

		const url = `${env.B2_ENDPOINT}/${env.B2_BUCKET}/${this.encodeKey(row.b2_key)}`;

		const res = await this.client(env).fetch(url, { method: 'GET' });

		if (!res.ok) {
			console.error('B2 回源失败', row.b2_key, res.status);
			return new Response('Archive source unavailable', { status: 502 });
		}

		const headers = new Headers();
		const ct = res.headers.get('content-type');
		const cd = res.headers.get('content-disposition');
		const cc = res.headers.get('cache-control');

		headers.set('content-type', ct || 'application/octet-stream');
		if (cd) {
			headers.set('content-disposition', cd);
		}
		if (cc) {
			headers.set('cache-control', cc);
		}
		// 便于排查：标记该响应来自冷归档
		headers.set('x-archive-source', 'b2');

		return new Response(res.body, { headers });
	}

};

export default b2Service;
