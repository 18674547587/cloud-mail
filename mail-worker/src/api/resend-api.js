import resendService from '../service/resend-service';
import app from '../hono/hono';

app.post('/webhooks', async (c) => {
	try {
		// 必须先取原始请求体文本做签名校验：
		// 签名对象是原始字节，一旦经过 c.req.json() 反序列化再 stringify，字段顺序/空格
		// 都可能变化，导致验签必然失败。
		const rawBody = await c.req.text();

		const verified = await resendService.verifyWebhook(c, rawBody, c.req.raw.headers);

		if (!verified) {
			return c.text('invalid signature', 401);
		}

		await resendService.webhooks(c, JSON.parse(rawBody));
		return c.text('success', 200)
	} catch (e) {
		// 注意：这里只应捕获「真正需要重试」的异常（例如 D1 暂时不可用）。
		// 业务上「事件不属于本系统」的情况已在 resendService.webhooks() 内部消化并返回 2xx，
		// 绝不能落到这里——否则 Svix 会无限重试，最终导致 Resend 禁用整个 webhook。
		console.error('webhook 处理异常:', e?.stack || e);
		return c.text(e.message, 500)
	}
})
