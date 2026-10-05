/**
 * 邮件认证结果（SPF / DKIM / DMARC）解析工具
 *
 * 背景：Cloudflare Email Routing 接收邮件时会对发件方做 SPF / DKIM / DMARC 校验，
 * 并把结果写入邮件头（2026-10 实测样本）：
 *   Authentication-Results: mx.cloudflare.net;
 *     dkim=pass header.d=95270.cc.cd header.s=resend header.b=JPqCTZZB;
 *     dmarc=pass header.from=95270.cc.cd policy.dmarc=none;
 *     spf=pass (mx.cloudflare.net: domain of ... designates 23.251.234.53 as permitted sender) smtp.mailfrom=...;
 *     arc=none smtp.remote-ip=23.251.234.53
 *   Received-SPF: pass (...)
 * 上游转发服务器也可能写入自己的 Authentication-Results，本工具一并保留原文。
 *
 * 输出为 JSON 可序列化对象：
 * {
 *   source:   'mx.cloudflare.net',   // 主结果的认证服务标识
 *   spf:      { result, ip, mailfrom, helo },
 *   dkim:     [ { result, domain, selector } ],
 *   dmarc:    { result, from, policy },
 *   arc:      'none' | 'pass' | ...,
 *   remoteIp: 'x.x.x.x',             // 发件方真实 IP
 *   raw:      '认证头原文（截断保护）'
 * }
 * 无任何认证头时返回 null。
 */

const TARGET_HEADER = /^(authentication-results|received-spf|arc-authentication-results)/i;
const RAW_MAX_LEN = 8000;

/** 从原始邮件文本中提取认证相关头（合并 RFC 5322 折叠行，支持多个同名头） */
function extractAuthHeaders(rawContent) {
	const idx = rawContent.search(/\r?\n\r?\n/);
	const headerPart = idx >= 0 ? rawContent.slice(0, idx) : rawContent.slice(0, 65536);
	const headers = [];
	let cur = null;
	for (const line of headerPart.split(/\r?\n/)) {
		if (/^[ \t]/.test(line)) {
			if (cur) cur.value += '\n' + line;
			continue;
		}
		const m = line.match(/^([!-9;-~]+):\s*([\s\S]*)$/);
		if (m) {
			cur = { key: m[1], value: m[2] };
			if (TARGET_HEADER.test(m[1])) headers.push(cur);
		}
	}
	return headers;
}

/** 按分号分段（忽略括号内的分号，SPF 的 reason 文本可能含分号） */
function splitSegments(value) {
	const segs = [];
	let depth = 0;
	let cur = '';
	for (const ch of value) {
		if (ch === '(') depth++;
		else if (ch === ')') depth = Math.max(0, depth - 1);
		if (ch === ';' && depth === 0) {
			segs.push(cur);
			cur = '';
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) segs.push(cur);
	return segs;
}

/** 提取属性值，如 prop(rest, 'header.d')；值可能带引号 */
function prop(rest, name) {
	const re = new RegExp('(?:^|[\\s;])' + name.replace(/\./g, '\\.') + '=("[^"]*"|[^\\s;]+)', 'i');
	const m = rest.match(re);
	return m ? m[1].replace(/^"|"$/g, '') : '';
}

/** 提取括号内文本（reason） */
function parenText(rest) {
	const m = rest.match(/\(([^)]*)\)/);
	return m ? m[1] : '';
}

/** 从文本中提取 IP（优先 designates ... as 句式） */
function extractIp(text) {
	let m = text.match(/designates\s+([0-9a-f.:]+)\s+as/i);
	if (m) return m[1];
	m = text.match(/client-ip[=:\s]+([0-9a-f.:]+)/i);
	if (m) return m[1];
	m = text.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
	if (m) return m[1];
	m = text.match(/\b([0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,})\b/i);
	return m ? m[1] : '';
}

/** 解析单个 Authentication-Results 头值 → { source, segments: [{method, result, rest}] } */
function parseAuthResultsValue(value) {
	const segs = splitSegments(value);
	const segments = [];
	let source = '';
	for (const seg of segs) {
		const m = seg.match(/^\s*([a-z][a-z0-9-]*)\s*=\s*([a-z]+)\b([\s\S]*)$/i);
		if (m) {
			segments.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase(), rest: m[3] || '' });
		} else if (!source && seg.trim() && !/^i=\d+$/i.test(seg.trim())) {
			source = seg.trim();
		}
	}
	if (segments.length === 0 && !source) return null;
	return { source, segments };
}

/** 解析 Received-SPF 头（兜底：没有 Authentication-Results 时使用） */
function parseReceivedSpf(value) {
	const rm = value.match(/^\s*([a-z]+)/i);
	const reason = parenText(value);
	return {
		result: rm ? rm[1].toLowerCase() : '',
		ip: extractIp(reason),
		mailfrom: prop(value, 'envelope-from'),
		helo: prop(value, 'helo')
	};
}

/** 主入口：解析邮件原文中的认证头，返回结构化结果；无认证头返回 null */
function parse(rawContent) {
	if (!rawContent) return null;

	const headers = extractAuthHeaders(rawContent);
	if (headers.length === 0) return null;

	const arHeaders = headers.filter((h) => /^authentication-results$/i.test(h.key));
	const receivedSpfHeader = headers.find((h) => /^received-spf$/i.test(h.key));

	const parsedList = arHeaders.map((h) => parseAuthResultsValue(h.value)).filter(Boolean);
	// 优先取 Cloudflare 的验证结果（最终接收方，最权威）
	const main = parsedList.find((p) => /cloudflare/i.test(p.source)) || parsedList[0] || null;

	if (!main && !receivedSpfHeader) return null;

	const out = {
		source: main ? main.source : '',
		spf: { result: '', ip: '', mailfrom: '', helo: '' },
		dkim: [],
		dmarc: { result: '', from: '', policy: '' },
		arc: '',
		remoteIp: '',
		raw: ''
	};

	if (main) {
		for (const seg of main.segments) {
			if (seg.method === 'spf') {
				out.spf.result = seg.result;
				const reason = parenText(seg.rest);
				if (!out.spf.ip) out.spf.ip = extractIp(reason) || extractIp(seg.rest);
				const mailfrom = prop(seg.rest, 'smtp.mailfrom');
				if (mailfrom) out.spf.mailfrom = mailfrom;
				const helo = prop(seg.rest, 'smtp.helo');
				if (helo) out.spf.helo = helo;
			} else if (seg.method === 'dkim') {
				// header.d 是 DKIM 签名域（SDID）；部分实现用 header.i（AUID，如 @gmail.com）代替
				let domain = prop(seg.rest, 'header.d');
				if (!domain) {
					const identity = prop(seg.rest, 'header.i');
					domain = identity ? identity.replace(/^@/, '') : '';
				}
				out.dkim.push({
					result: seg.result,
					domain: domain,
					selector: prop(seg.rest, 'header.s')
				});
			} else if (seg.method === 'dmarc') {
				out.dmarc.result = seg.result;
				out.dmarc.from = prop(seg.rest, 'header.from');
				out.dmarc.policy = prop(seg.rest, 'policy.dmarc');
			} else if (seg.method === 'arc') {
				out.arc = seg.result;
				const ip = prop(seg.rest, 'smtp.remote-ip');
				if (ip) out.remoteIp = ip;
			}
		}
	}

	// 没有 Authentication-Results 时用 Received-SPF 兜底
	if (!out.spf.result && receivedSpfHeader) {
		const spf = parseReceivedSpf(receivedSpfHeader.value);
		out.spf = { result: spf.result, ip: spf.ip, mailfrom: spf.mailfrom, helo: spf.helo };
	}

	if (!out.spf.result && out.dkim.length === 0 && !out.dmarc.result && !out.arc) return null;

	// 原文（保留所有 Authentication-Results + Received-SPF，截断保护）
	const rawParts = [];
	for (const h of arHeaders) rawParts.push(h.key + ': ' + h.value);
	if (receivedSpfHeader) rawParts.push(receivedSpfHeader.key + ': ' + receivedSpfHeader.value);
	out.raw = rawParts.join('\n\n').slice(0, RAW_MAX_LEN);

	return out;
}

export default { parse, extractAuthHeaders };
