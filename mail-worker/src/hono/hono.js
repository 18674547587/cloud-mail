import { Hono } from 'hono';
const app = new Hono();

import result from '../model/result';
import { cors } from 'hono/cors';

app.use('*', cors());

app.onError((err, c) => {
	// 重要：Hono 的 onError 会把异常转成 Response 返回，异常不会再向上抛出，
	// 因此外层中间件（log-middleware）的 try/catch 捕获不到。
	// 这里把异常挂到 context 上，供日志中间件读取，从而能记录到真实的错误码与错误栈。
	// 注意：HTTP 状态码必须保持 200，前端 axios 拦截器依赖响应体里的 code 字段判断。
	try {
		c.set('logError', err);
	} catch (e) { /* ignore */ }

	if (err.name === 'BizError') {
		console.log(err.message);
	} else {
		console.error(err);
	}

	if (err.message === `Cannot read properties of undefined (reading 'get')`) {
		return c.json(result.fail('KV数据库未绑定 KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'put')`) {
		return c.json(result.fail('KV数据库未绑定 KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'prepare')`) {
		return c.json(result.fail('D1数据库未绑定 D1 database not bound',502));
	}

	return c.json(result.fail(err.message, err.code));
});

export default app;


