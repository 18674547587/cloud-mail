import http from '@/axios/index.js'


export function userList(params) {
    return http.get('/user/list', {params: {...params}})
}

export function userSetPwd(params) {
    return http.put('/user/setPwd', params)
}

export function userSetStatus(params) {
    return http.put('/user/setStatus', params)
}

export function userSetType(params) {
    return http.put('/user/setType', params)
}


export function userDelete(userIds) {
    return http.delete('/user/delete', {params:{userIds: userIds + ''}})
}

export function userAdd(form) {
    return http.post('/user/add', form)
}

export function userRestSendCount(userId) {
    return http.put('/user/resetSendCount', {userId})
}

export function userRestore(userId,type) {
    return http.put('/user/restore', {userId,type})
}

export function userAllAccount(userId, num, size) {
    return http.get('/user/allAccount', {params:{userId,num,size}})
}

export function userDeleteAccount(accountId) {
    return http.delete('/user/deleteAccount', {params:{accountId}})
}

// ===================== 头像（管理员代设） =====================

// 把已上传的头像挂到指定用户身上
export function userSetAvatar(params) {
    return http.put('/user/avatar', params)
}

// 清除指定用户的头像
export function userRemoveAvatar(userId) {
    return http.delete('/user/avatar', {params: {userId}})
}
