import http from '@/axios/index.js';

/**
 * 设备令牌（App Token）管理
 *
 * 对应后端 src/api/app-api.js，需 JWT 鉴权（走正常登录态）。
 * 设备令牌用于 Android 客户端登录 /api/login/app，可单独吊销。
 */

// 创建新的设备令牌（明文 token 仅返回一次）
export function createAppToken(name) {
    return http.post('/app/token', {name})
}

// 查看已授权的设备列表（不含明文）
export function listAppToken() {
    return http.get('/app/token/list')
}

// 吊销指定设备令牌
export function revokeAppToken(tokenId) {
    return http.delete('/app/token/revoke', {params: {tokenId}})
}
