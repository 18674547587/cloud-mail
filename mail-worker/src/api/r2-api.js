import r2Service from '../service/r2-service';
import constant from '../const/constant';
import app from '../hono/hono';

app.get('/oss/*', async (c) => {
	let key = c.req.path.split('/oss/')[1];
	try {
		key = decodeURIComponent(key);
	} catch (e) { /* 保留原值 */ }
	// 安全收窄：该路由为免鉴权公开访问（用于邮件内嵌图片），
	// 仅允许访问附件前缀，防止读取对象存储中的其他任意对象
	if (!key || !key.startsWith(constant.ATTACHMENT_PREFIX)) {
		return c.text('Not Found', 404);
	}
	return await r2Service.toObjResp(c, key);
});


