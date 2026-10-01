import app from '../hono/hono';
import logService from './log-service';
import { LOG_LIMIT } from '../const/log-const';

/**
 * 只读取请求体的前 maxBytes 个字节，用于日志预览。
 *
 * 为什么不用 req.text()：
 *  1. 会读入完整请求体（可能是几十 MB），内存翻倍，Workers 内存上限 128 MB；
 *  2. 二进制内容会被整体按 UTF-8 解码成乱码字符串；
 *  3. 日志只需要前几千字节，读全量纯属浪费。
 * 这里用流式 reader 读到上限就 cancel，读的是 clone 出来的分支，不影响原请求。
 */
async function readBodyPreview(req, maxBytes) {
	if (!req || !req.body) {
		return { text: '', bytes: 0 };
	}

	const reader = req.body.getReader();
	const chunks = [];
	let size = 0;

	try {
		while (size < maxBytes) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value && value.byteLength) {
				chunks.push(value);
				size += value.byteLength;
			}
		}
	} catch (e) {
		// 读取失败（例如请求体已被取消）按空处理
	} finally {
		try {
			await reader.cancel();
		} catch (e) { /* ignore */ }
	}

	if (!size) {
		return { text: '', bytes: 0 };
	}

	const buf = new Uint8Array(Math.min(size, maxBytes));
	let offset = 0;
	for (const chunk of chunks) {
		const take = Math.min(chunk.byteLength, buf.byteLength - offset);
		if (take <= 0) {
			break;
		}
		buf.set(chunk.subarray(0, take), offset);
		offset += take;
	}

	let text = '';
	try {
		text = new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, offset));
	} catch (e) {
		text = '';
	}

	return { text, bytes: size };
}

/**
 * 全局日志中间件
 *
 * 注册位置：必须在 security 之前（webs.js 中先 import 本文件），
 * 这样它是洋葱模型的最外层，能覆盖所有请求（含 /login、/register 等免鉴权路径），
 * 并且能在 security 执行后通过 c.get('user') 拿到登录用户。
 *
 * 性能说明：
 *  - 请求体只做 clone + 读取前 LOG_LIMIT.BODY 字节，不消费原始 body
 *  - 所有写日志动作放进 executionCtx.waitUntil，不阻塞响应
 */
app.use('*', async (c, next) => {

	const start = Date.now();

	// 同步克隆请求体，供日志记录使用（不消费原请求体）
	let clonedReq = null;
	try {
		clonedReq = c.req.raw.clone();
	} catch (e) {
		clonedReq = null;
	}

	let error = null;
	let status = 200;
	let responseLength = 0;

	try {
		await next();

		if (c.res) {
			status = c.res.status;
			const len = c.res.headers.get('content-length');
			if (len) {
				responseLength = Number(len) || 0;
			}
		}
	} catch (e) {
		error = e;
		status = e && e.code ? e.code : 500;
	}

	// Hono 的 onError 会在错误发生的那一层就把异常转成 Response（默认 HTTP 200），
	// 异常不会再向上抛，所以上面的 catch 基本不会命中。
	// 这里再从 context 取一次 onError 存下来的真实异常，保证错误能被记录。
	if (!error) {
		try {
			error = c.get('logError') || null;
		} catch (e) {
			error = null;
		}
		if (error) {
			status = typeof error.code === 'number' ? error.code : 500;
		}
	}

	// 异步记录，不阻塞响应
	const recordTask = (async () => {
		let bodyText = '';
		let bodyLength = 0;

		if (clonedReq) {
			const preview = await readBodyPreview(clonedReq, LOG_LIMIT.BODY);
			bodyText = preview.text;
			bodyLength = preview.bytes;
		}

		await logService.record(c, {
			start,
			body: bodyText,
			bodyLength,
			error,
			status,
			responseLength
		});
	})().catch(e => console.error('log middleware failed:', e && e.message));

	try {
		if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
			c.executionCtx.waitUntil(recordTask);
		} else {
			await recordTask;
		}
	} catch (e) {
		// 日志写入失败不能影响业务
		console.error('log waitUntil failed:', e && e.message);
	}

	// 把异常继续抛给 hono 的 onError 处理，保持原有响应逻辑
	if (error) {
		throw error;
	}
});

export default app;
