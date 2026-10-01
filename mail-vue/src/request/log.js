import http from '@/axios/index.js';
import axios from 'axios';

export function logConfig() {
    return http.get('/log/config')
}

export function setLogConfig(data) {
    return http.put('/log/config', data)
}

/* 请求明细（Analytics Engine） */
export function reqLogList(params) {
    return http.get('/log/req/list', {params})
}

export function reqLogOverview(params) {
    return http.get('/log/req/overview', {params})
}

export function reqLogTopPaths(params) {
    return http.get('/log/req/topPaths', {params})
}

/* 审计日志（D1） */
export function auditLogList(params) {
    return http.get('/log/audit/list', {params})
}

export function auditLogDetail(logId) {
    return http.get('/log/audit/detail', {params: {logId}})
}

export function clearAuditLog(params) {
    return http.delete('/log/audit/clear', {params})
}

/* 统计（D1 每日聚合） */
export function logStatList(params) {
    return http.get('/log/stat/list', {params})
}

export function logStatPathList(params) {
    return http.get('/log/stat/pathList', {params})
}

/**
 * 导出 CSV
 * 说明：走原生 axios，因为全局拦截器会把 Blob 响应当成业务 JSON 处理
 */
export async function auditLogExport(params) {
    const res = await axios.get(import.meta.env.VITE_BASE_URL + '/log/audit/export', {
        params,
        responseType: 'blob',
        headers: {
            Authorization: `${localStorage.getItem('token')}`,
            'accept-language': localStorage.getItem('lang') || 'zh'
        }
    })
    return res.data
}
