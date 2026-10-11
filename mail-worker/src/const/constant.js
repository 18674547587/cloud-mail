const constant = {
	TOKEN_HEADER: 'Authorization',
	JWT_UID: 'user_id:',
	JWT_TOKEN: 'token:',
	TOKEN_EXPIRE: 60 * 60 * 24 * 30,
	ATTACHMENT_PREFIX: 'attachments/',
	AVATAR_PREFIX: 'avatar/',
	// 头像体积的宽松硬上限（服务端不做压缩，仅防滥用；前端另有更小的提示阈值）
	AVATAR_MAX_SIZE: 20 * 1024 * 1024,
	BACKGROUND_PREFIX: 'static/background/',
	ADMIN_ROLE: {
		name: 'admin',
		sendCount: 0,
		sendType: 'count',
		accountCount: 0
	}
}

export default constant
