/**
 * MailPush —— 邮件实时推送 Durable Object
 *
 * 职责：
 *   1. 持有某个用户的所有 WebSocket 连接（按 userId 分实例）
 *   2. 新邮件到达时，向该用户所有在线连接下发一个"信号包"
 *   3. 用户不在线（无连接）时直接返回，不下发任何内容
 *
 * ⚠️ 计费要点（务必遵守，否则会产生意外费用）：
 *   - 必须使用 WebSocket Hibernation API（state.acceptWebSocket）。
 *     若改用普通的 server.accept()，连接存续期间会持续产生 Duration 计费，
 *     单个连接挂 24 小时约消耗 10,800 GB-s，远超免费额度 13,000 GB-s/天。
 *   - 心跳使用 setWebSocketAutoResponse 自动应答，在休眠状态下完成，
 *     不唤醒 DO、不计费。
 *   - 服务端下发的消息（outgoing）不计费。
 */

const HEARTBEAT_REQUEST = 'ping';
const HEARTBEAT_RESPONSE = 'pong';

export class MailPush {

	constructor(state, env) {
		this.state = state;
		this.env = env;

		// 心跳自动应答：休眠状态下也能回复，不唤醒 DO、不产生 Duration 计费
		try {
			this.state.setWebSocketAutoResponse(
				new WebSocketRequestResponsePair(HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE)
			);
		} catch (e) {
			console.error('setWebSocketAutoResponse 不可用：', e);
		}
	}

	async fetch(request) {
		const url = new URL(request.url);

		// 1) 客户端建立 WebSocket 连接
		if (request.headers.get('Upgrade') === 'websocket') {
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			// Hibernation API：连接存续期间不计 Duration
			this.state.acceptWebSocket(server);

			return new Response(null, { status: 101, webSocket: client });
		}

		// 2) 内部通知：有新邮件到达（由 email handler 调用）
		if (url.pathname === '/notify') {
			const sockets = this.state.getWebSockets();

			// 用户不在线：直接返回，不下发
			if (sockets.length === 0) {
				return Response.json({ online: 0, pushed: 0 });
			}

			let payload = {};
			try {
				payload = await request.json();
			} catch (e) {
				payload = {};
			}

			const message = JSON.stringify({
				type: 'new-email',
				ts: Date.now(),
				data: payload
			});

			let pushed = 0;
			for (const socket of sockets) {
				try {
					socket.send(message);
					pushed++;
				} catch (e) {
					console.error('推送失败：', e);
				}
			}

			return Response.json({ online: sockets.length, pushed });
		}

		// 3) 调试用：查询当前在线连接数
		if (url.pathname === '/status') {
			return Response.json({ online: this.state.getWebSockets().length });
		}

		return new Response('Not Found', { status: 404 });
	}

	/**
	 * Hibernation 回调：收到客户端消息时触发。
	 * 心跳（ping）已被 setWebSocketAutoResponse 自动处理，正常情况下不会走到这里。
	 */
	async webSocketMessage(socket, message) {
		if (typeof message === 'string' && message === HEARTBEAT_REQUEST) {
			try {
				socket.send(HEARTBEAT_RESPONSE);
			} catch (e) {
				// 忽略
			}
		}
	}

	/**
	 * Hibernation 回调：连接关闭。连接状态由运行时维护，无需额外处理。
	 */
	async webSocketClose(socket, code, reason, wasClean) {
		// 空实现即可
	}

	/**
	 * Hibernation 回调：连接出错。
	 */
	async webSocketError(socket, error) {
		console.error('WebSocket 错误：', error);
	}
}

export default MailPush;
