import app from '../hono/hono';
import loginService from '../service/login-service';
import result from '../model/result';
import userContext from '../security/user-context';
import turnstileService from '../service/turnstile-service';

app.post('/login', async (c) => {
	const params = await c.req.json();
	if (params.token) {
		await turnstileService.verify(c, params.token);
	}
	const token = await loginService.login(c, params);
	return c.json(result.ok({ token: token }));
});

app.post('/register', async (c) => {
	const jwt = await loginService.register(c, await c.req.json());
	return c.json(result.ok(jwt));
});

app.delete('/logout', async (c) => {
	await loginService.logout(c, userContext.getUserId(c));
	return c.json(result.ok());
});
