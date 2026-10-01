import http from '@/axios/index.js';

// 申请附件直传凭证，返回 { key, uploadUrl, headers }
export function attPresign(data) {
    return http.post('/att/presign', data)
}
