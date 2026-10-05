/**
 * 邮件认证结果（SPF / DKIM / DMARC / ARC）解析工具
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
 * 输出为 JSON 可序列化对象（v2，含详细字段）：
 * {
 *   source:   'mx.cloudflare.net',   // 主结果的认证服务标识
 *   spf:      { result, ip, mailfrom, helo, segments: [ { type, value, result, reason } ] },
 *   dkim:     [ { result, domain, selector, algorithm, canon, query, timestamp,
 *                 sigHash, bodyHash, headers } ],
 *   dmarc:    { result, from, policy, spfAligned, dkimAligned },
 *   arc:      'none' | 'pass' | ...,
 *   arcChain: [ { instance, seal: {cv,d,s,a}, ams: {d,s,a}, aar } ],
 *   received: [ 'from ... by ... ; date', ... ],   // 传递路径（新→旧）
 *   spamScore:'2',                    // X-CF-SpamH-Score
 *   remoteIp: 'x.x.x.x',              // 发件方真实 IP
 *   raw:      '认证相关头完整原文（截断保护）'
 * }
 * 无任何认证头时返回 null。
 */

const TARGET_HEADER = /^(authentication-results|received-spf|arc-authentication-results|arc-seal|arc-message-signature|dkim-signature|received|x-cf-spamh-score)$/i;
const RAW_KEYS = /^(authentication-results|received-spf|dkim-signature|arc-seal|arc-message-signature|arc-authentication-results|received|x-cf-spamh-score)$/i;
const RAW_MAX_LEN = 50000;

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

/** 解析 tag=value; 格式（DKIM-Signature / ARC-Seal / ARC-Message-Signature 共用） */
function parseTagValue(value) {
	const flat = value.replace(/\r?\n[\s]+/g, ' ').replace(/\s+/g, ' ');
	const tags = {};
	for (const seg of splitSegments(flat)) {
		const m = seg.match(/^\s*([a-z0-9]+)\s*=\s*([\s\S]*?)\s*$/i);
		if (m) {
			const k = m[1].toLowerCase();
			let v = m[2].trim();
			// b= / bh= 是 base64 值：折叠空白应整体移除，避免破坏签名文本
			if (k === 'b' || k === 'bh') v = v.replace(/\s+/g, '');
			tags[k] = v;
		}
	}
	return tags;
}

/** 解析所有 DKIM-Signature 头 → 签名详情数组 */
function parseDkimSignatures(headers) {
	return headers
		.filter((h) => /^dkim-signature$/i.test(h.key))
		.map((h) => {
			const t = parseTagValue(h.value);
			return {
				domain: t.d || '',
				selector: t.s || '',
				algorithm: t.a || '',
				canon: t.c || '',
				query: t.q || '',
				timestamp: t.t ? Number(t.t) || t.t : '',
				bodyHash: t.bh || '',
				headers: t.h || '',
				sigHash: t.b ? t.b.slice(0, 8) : ''
			};
		});
}

/** 解析 ARC 链（ARC-Seal / ARC-Message-Signature / ARC-Authentication-Results 按 i= 组装） */
function parseArcChain(headers) {
	const seals = headers.filter((h) => /^arc-seal$/i.test(h.key)).map((h) => parseTagValue(h.value));
	const amss = headers.filter((h) => /^arc-message-signature$/i.test(h.key)).map((h) => parseTagValue(h.value));
	const aars = headers.filter((h) => /^arc-authentication-results$/i.test(h.key));

	const instanceOf = (v) => {
		const m = String(v || '').match(/^\s*i\s*=\s*(\d+)/i);
		return m ? Number(m[1]) : 0;
	};

	const maxI = Math.max(
		0,
		...seals.map((s) => Number(s.i) || 0),
		...amss.map((s) => Number(s.i) || 0),
		...aars.map((h) => instanceOf(h.value))
	);

	const chain = [];
	for (let i = 1; i <= maxI; i++) {
		const seal = seals.find((s) => Number(s.i) === i);
		const ams = amss.find((s) => Number(s.i) === i);
		const aar = aars.find((h) => instanceOf(h.value) === i);
		if (seal || ams || aar) {
			chain.push({
				instance: i,
				seal: seal ? { cv: seal.cv || '', d: seal.d || '', s: seal.s || '', a: seal.a || '' } : null,
				ams: ams ? { d: ams.d || '', s: ams.s || '', a: ams.a || '' } : null,
				aar: aar ? aar.value.replace(/\r?\n[\s]+/g, ' ').replace(/\s+/g, ' ').trim() : ''
			});
		}
	}
	return chain;
}

/** 提取 Received 传递路径（折叠行合并为单行，保留原始顺序：新 → 旧） */
function parseReceived(headers) {
	return headers
		.filter((h) => /^received$/i.test(h.key))
		.map((h) => h.value.replace(/\r?\n[\s]+/g, ' ').replace(/\s+/g, ' ').trim());
}

/** 从地址提取域名（awm0317@qq.com → qq.com） */
function domainOf(addr) {
	if (!addr) return '';
	const at = String(addr).lastIndexOf('@');
	return (at >= 0 ? String(addr).slice(at + 1) : String(addr)).toLowerCase().replace(/\.$/, '');
}

/** 对齐判断（简化版：域相同或互为子域，近似 relaxed 对齐） */
function isAligned(domain, fromDomain) {
	if (!domain || !fromDomain) return null;
	const a = String(domain).toLowerCase().replace(/\.$/, '');
	const b = String(fromDomain).toLowerCase().replace(/\.$/, '');
	if (!a || !b) return null;
	return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
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
		spf: { result: '', ip: '', mailfrom: '', helo: '', segments: [] },
		dkim: [],
		dmarc: { result: '', from: '', policy: '', spfAligned: null, dkimAligned: null },
		arc: '',
		arcChain: [],
		received: parseReceived(headers),
		spamScore: '',
		remoteIp: '',
		raw: ''
	};

	if (main) {
		const spfSegs = main.segments.filter((s) => s.method === 'spf');

		// SPF：逐段解析（helo / mailfrom），综合结果优先 mailfrom 段
		for (const seg of spfSegs) {
			const mailfrom = prop(seg.rest, 'smtp.mailfrom');
			const helo = prop(seg.rest, 'smtp.helo');
			const type = mailfrom ? 'mailfrom' : helo ? 'helo' : 'other';
			const value = mailfrom || helo || '';
			const reason = parenText(seg.rest);
			out.spf.segments.push({ type, value, result: seg.result, reason });
			if (!out.spf.ip) out.spf.ip = extractIp(reason) || extractIp(seg.rest);
			if (mailfrom && !out.spf.mailfrom) out.spf.mailfrom = mailfrom;
			if (helo && !out.spf.helo) out.spf.helo = helo;
		}
		const mailfromSeg = spfSegs.find((s) => prop(s.rest, 'smtp.mailfrom'));
		const heloSeg = spfSegs.find((s) => prop(s.rest, 'smtp.helo'));
		if (mailfromSeg) out.spf.result = mailfromSeg.result;
		else if (heloSeg) out.spf.result = heloSeg.result;
		else if (spfSegs.length) out.spf.result = spfSegs[spfSegs.length - 1].result;

		for (const seg of main.segments) {
			if (seg.method === 'dkim') {
				// header.d 是 DKIM 签名域（SDID）；部分实现用 header.i（AUID，如 @gmail.com）代替
				let domain = prop(seg.rest, 'header.d');
				if (!domain) {
					const identity = prop(seg.rest, 'header.i');
					domain = identity ? identity.replace(/^@/, '') : '';
				}
				out.dkim.push({
					result: seg.result,
					domain: domain,
					selector: prop(seg.rest, 'header.s'),
					sigHash: prop(seg.rest, 'header.b'),
					algorithm: '',
					canon: '',
					query: '',
					timestamp: '',
					bodyHash: '',
					headers: ''
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

	// 用 DKIM-Signature 头补充签名详情（按 d + s 匹配），未匹配的单独追加
	const dkimSigs = parseDkimSignatures(headers);
	for (const sig of out.dkim) {
		const detail = dkimSigs.find((d) => d.domain && d.domain === sig.domain && d.selector === sig.selector);
		if (detail) {
			sig.algorithm = detail.algorithm;
			sig.canon = detail.canon;
			sig.query = detail.query;
			sig.timestamp = detail.timestamp;
			sig.bodyHash = detail.bodyHash;
			sig.headers = detail.headers;
			if (!sig.sigHash) sig.sigHash = detail.sigHash;
			detail.__matched = true;
		}
	}
	for (const detail of dkimSigs) {
		if (!detail.__matched) {
			out.dkim.push({
				result: '',
				domain: detail.domain,
				selector: detail.selector,
				sigHash: detail.sigHash,
				algorithm: detail.algorithm,
				canon: detail.canon,
				query: detail.query,
				timestamp: detail.timestamp,
				bodyHash: detail.bodyHash,
				headers: detail.headers
			});
		}
	}

	// 没有 Authentication-Results 时用 Received-SPF 兜底
	if (!out.spf.result && receivedSpfHeader) {
		const spf = parseReceivedSpf(receivedSpfHeader.value);
		out.spf = { result: spf.result, ip: spf.ip, mailfrom: spf.mailfrom, helo: spf.helo, segments: [] };
	}

	// DMARC 对齐判断（简化：域相同或互为子域）
	if (out.dmarc.from) {
		out.dmarc.spfAligned = isAligned(domainOf(out.spf.mailfrom), out.dmarc.from);
		out.dmarc.dkimAligned = out.dkim.length > 0 ? out.dkim.some((s) => isAligned(s.domain, out.dmarc.from)) : null;
	}

	out.arcChain = parseArcChain(headers);

	const spamHeader = headers.find((h) => /^x-cf-spamh-score$/i.test(h.key));
	out.spamScore = spamHeader ? spamHeader.value.trim() : '';

	if (!out.spf.result && out.dkim.length === 0 && !out.dmarc.result && !out.arc) return null;

	// 原文（认证相关头完整文本，截断保护）
	const rawParts = [];
	for (const h of headers) {
		if (RAW_KEYS.test(h.key)) rawParts.push(h.key + ': ' + h.value);
	}
	out.raw = rawParts.join('\n\n').slice(0, RAW_MAX_LEN);

	return out;
}

export default { parse, extractAuthHeaders };
