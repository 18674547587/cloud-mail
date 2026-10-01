/**
 * 邮件实时推送客户端
 *
 * 与后端 MailPush Durable Object 配合：
 *   网页建立 WebSocket → Worker 校验 token → 转发给该用户的 DO 实例
 *   新邮件到达 → DO 下发 { type: 'new-email' } 信号 → 网页自行拉取邮件列表
 *
 * 说明：
 *   - 只下发"有新邮件"的信号，不传邮件正文，避免大报文与权限绕过
 *   - 断线自动重连（指数退避），期间由原有的轮询兜底
 *   - 心跳使用 ping/pong，服务端用 setWebSocketAutoResponse 自动应答，不计费
 */

const HEARTBEAT_INTERVAL = 25 * 1000;
const MAX_RECONNECT_DELAY = 30 * 1000;

let socket = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let manuallyClosed = false;

const listeners = new Set();

/**
 * 构造 WebSocket 地址（token 只能走 URL 参数，WebSocket 无法自定义请求头）
 */
function buildUrl() {
    const token = localStorage.getItem('token');
    if (!token) return null;

    const base = import.meta.env.VITE_BASE_URL || '/api';
    let url;

    if (/^https?:\/\//i.test(base)) {
        url = base.replace(/^http/i, 'ws');
    } else {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        url = proto + '//' + location.host + base;
    }

    return url.replace(/\/+$/, '') + '/push/ws?token=' + encodeURIComponent(token);
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            try {
                socket.send('ping');
            } catch (e) {
                // 忽略，交给 onclose 处理重连
            }
        }
    }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

function scheduleReconnect() {
    if (manuallyClosed) return;
    if (reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        connect();
    }, reconnectDelay);
}

/**
 * 建立连接（已连接或正在连接时直接返回）
 */
export function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        return;
    }

    const url = buildUrl();
    if (!url) return;

    manuallyClosed = false;

    try {
        socket = new WebSocket(url);
    } catch (e) {
        console.warn('实时推送：创建 WebSocket 失败', e);
        socket = null;
        scheduleReconnect();
        return;
    }

    socket.onopen = () => {
        reconnectDelay = 1000;
        startHeartbeat();
    };

    socket.onmessage = (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (e) {
            return;
        }

        if (message && message.type === 'new-email') {
            listeners.forEach(fn => {
                try {
                    fn(message);
                } catch (e) {
                    console.error('实时推送回调异常：', e);
                }
            });
        }
    };

    socket.onclose = () => {
        stopHeartbeat();
        socket = null;
        scheduleReconnect();
    };

    socket.onerror = () => {
        // onclose 会随之触发，重连逻辑统一在 onclose 处理
    };
}

/**
 * 主动断开并停止重连
 */
export function disconnect() {
    manuallyClosed = true;
    stopHeartbeat();

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (socket) {
        try {
            socket.close();
        } catch (e) {
            // 忽略
        }
        socket = null;
    }
}

/**
 * 注册"收到新邮件"回调
 * @param {(msg: object) => void} fn
 * @returns {() => void} 取消注册函数
 */
export function onNewEmail(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * 当前是否已连接
 */
export function isConnected() {
    return !!socket && socket.readyState === WebSocket.OPEN;
}

export default { connect, disconnect, onNewEmail, isConnected };
