const fileUtils = {
	getExtFileName(filename) {
		try {
			const index = filename.lastIndexOf('.');
			return index !== -1 ? filename.slice(index) : '';
		} catch (e) {
			return ''
		}
	},

	async getBuffHash(buff) {
		const hashBuffer = await crypto.subtle.digest('SHA-256', buff);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
	},

	base64ToDataStr(base64) {
		return base64.split(',')[1] || base64;
	},

	base64ToUint8Array(base64) {
		const binaryStr = atob(base64);
		const len = binaryStr.length;
		const bytes = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			bytes[i] = binaryStr.charCodeAt(i);
		}
		return bytes;
	},

	// 生成符合 RFC 5987 的 Content-Disposition
	// 非 ASCII 文件名（中文等）直接拼进响应头会抛 TypeError，必须提供 ASCII 回退名 + filename*
	contentDisposition(filename, inline = false) {
		const name = String(filename || 'file');
		const asciiFallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
		return `${inline ? 'inline' : 'attachment'}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
	},

	// 人类可读的文件体积
	formatSize(bytes) {
		const size = Number(bytes) || 0;
		if (size < 1024) {
			return size + ' B';
		}
		const units = ['KB', 'MB', 'GB', 'TB'];
		let value = size / 1024;
		let index = 0;
		while (value >= 1024 && index < units.length - 1) {
			value /= 1024;
			index++;
		}
		return value.toFixed(2) + ' ' + units[index];
	},

	/**
	 * 将 Base64 数据转换为 File 对象（自动识别 MIME 类型和文件扩展名）
	 * @param {string} base64Data 带有 data: 前缀的 base64 数据
	 * @param {string} [customFilename] 可选，传入自定义文件名（不含扩展名）
	 * @returns {File} File 对象
	 */
	base64ToFile(base64Data, customFilename) {
		const match = base64Data.match(/^data:(image|jpeg|video)\/([a-zA-Z0-9.+-]+);base64,/);
		if (!match) {
			throw new Error('Invalid base64 data format');
		}

		const type = match[1]; // image 或 video
		const ext = match[2];  // jpg, png, mp4 等
		const mimeType = `${type}/${ext}`;
		const cleanBase64 = base64Data.replace(/^data:(image|jpeg|video)\/[a-zA-Z0-9.+-]+;base64,/, '');

		const byteCharacters = atob(cleanBase64);
		const byteArrays = [];

		for (let offset = 0; offset < byteCharacters.length; offset += 1024) {
			const slice = byteCharacters.slice(offset, offset + 1024);
			const byteNumbers = new Array(slice.length);
			for (let i = 0; i < slice.length; i++) {
				byteNumbers[i] = slice.charCodeAt(i);
			}
			byteArrays.push(new Uint8Array(byteNumbers));
		}

		const blob = new Blob(byteArrays, { type: mimeType });

		const filename = `${customFilename || `${type}_${Date.now()}`}.${ext}`;
		return new File([blob], filename, { type: mimeType });
	}
};


export default fileUtils;

