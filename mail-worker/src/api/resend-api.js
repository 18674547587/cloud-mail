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
		return c.text(e.message, 500)
	}
})
