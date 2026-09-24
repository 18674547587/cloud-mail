const domainUtils = {

	// 把 env.domain 归一化为 ['example.com','example2.com']（不带 @）
	// 兼容：数组 / JSON 字符串 / 逗号分隔字符串 / 对象（如 {"0":"a.com"}、{"domain":[...]}）
	// 返回 null 表示未配置；JSON 非法时抛出 code = 'NOT_JSON_DOMAIN' 的错误
	parseDomainList(value) {

		const normalize = (list) => list
			.map(item => String(item).trim().replace(/^@+/, ''))
			.filter(Boolean);

		if (value === undefined || value === null || value === '') {
			return null;
		}

		if (Array.isArray(value)) {
			return normalize(value);
		}

		if (typeof value === 'string') {
			const str = value.trim();
			if (str.startsWith('[') || str.startsWith('{')) {
				let parsed;
				try {
					parsed = JSON.parse(str);
				} catch (e) {
					const err = new Error('environment variable "domain" is not valid JSON');
					err.code = 'NOT_JSON_DOMAIN';
					throw err;
				}
				return this.parseDomainList(parsed);
			}
			return normalize(str.split(','));
		}

		if (typeof value === 'object') {
			const flat = [];
			Object.values(value).forEach(item => {
				Array.isArray(item) ? flat.push(...item) : flat.push(item);
			});
			return normalize(flat);
		}

		return null;
	},

	toOssDomain(domain) {

		if (!domain) {
			return null
		}

		if (!domain.startsWith('http')) {
			return 'https://' + domain
		}

		if (domain.endsWith("/")) {
			domain = domain.slice(0, -1);
		}

		return domain
	}
}

export default  domainUtils
