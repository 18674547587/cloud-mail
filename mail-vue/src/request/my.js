import http from '@/axios/index.js';

export function loginUserInfo() {
    return http.get('/my/loginUserInfo')
}

export function resetPassword(password) {
    return http.put('/my/resetPassword', {password})
}

export function userDelete() {
    return http.delete('/my/delete')
}

// 人机验证：取当前用户应使用的 provider 与 site key（服务端决策）
export function captchaConfig() {
    return http.get('/my/captchaConfig')
}

// 保存用户的人机验证偏好：0 = 跟随默认，1 = Turnstile，2 = hCaptcha
export function saveCaptchaProvider(captchaProvider) {
    return http.put('/my/captchaProvider', {captchaProvider})
}

// ===================== 头像 =====================

// 申请头像直传凭证，返回 { key, uploadUrl, headers }
export function avatarPresign(data) {
    return http.post('/my/avatar/presign', data)
}

// 上传完成后确认保存
export function saveAvatar(key) {
    return http.put('/my/avatar', {key})
}

// 移除头像
export function removeAvatar() {
    return http.delete('/my/avatar')
}
