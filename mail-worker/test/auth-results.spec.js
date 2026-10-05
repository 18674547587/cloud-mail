/**
 * 邮件认证结果（SPF/DKIM/DMARC）解析器单元测试
 *
 * 样本 1 为 2026-10-05 线上实测的真实邮件头（Cloudflare Email Routing 写入）。
 */
import { describe, it, expect } from 'vitest';
import authResultsUtils from '../src/utils/auth-results-utils.js';

// ===== 样本 1：线上实测（Resend → Cloudflare Email Routing → cloud-mail） =====
const REAL_SAMPLE = `Received: from e234-53.smtp-out.ap-northeast-1.amazonses.com (23.251.234.53)
        by cloudflare-email.net (cloudflare) id 8mKYJccFWNie
        for <admin@1206201.xyz>; Mon, 05 Oct 2026 05:38:55 +0000
ARC-Seal: i=1; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=none;
\tb=Q3quQWapVQS6QWtxtE1s3GquexHfDel+Wdm3cGCy+jp6IWmL7mR+n93dZ+5JsZs2a8+PdqdRE;
ARC-Message-Signature: i=1; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; c=relaxed/relaxed;
\th=Date:Subject:To:From; t=1791178736; x=1791783536; bh=04xlKIuf3PcMTfWoyxi4f1FqEDPt8DrW8i60i2tnayg=;
\tb=OC2uBi23xUkEm+XJ1TiK+0r7ZXfrweqTtDOkTquur9rLiN/FwlWM8QvRJe0nxBqV50KO9xF9u3z9PQxXBETSgOeRw;
ARC-Authentication-Results: i=1; mx.cloudflare.net;
\tdkim=pass header.d=95270.cc.cd header.s=resend header.b=JPqCTZZB;
\tdkim=pass header.d=amazonses.com header.s=zh4gjftm6etwoq6afzugpky45synznly header.b=d8suBF47;
\tdmarc=pass header.from=95270.cc.cd policy.dmarc=none;
\tspf=pass (mx.cloudflare.net: domain of postmaster@e234-53.smtp-out.ap-northeast-1.amazonses.com designates 23.251.234.53 as permitted sender) smtp.helo=e234-53.smtp-out.ap-northeast-1.amazonses.com;
\tspf=pass (mx.cloudflare.net: domain of 010601a10a927f10-8e69e9ce-3fd0-4871-aec7-2e2141cce5e8-000000@send.95270.cc.cd designates 23.251.234.53 as permitted sender) smtp.mailfrom=010601a10a927f10-8e69e9ce-3fd0-4871-aec7-2e2141cce5e8-000000@send.95270.cc.cd;
\tarc=none smtp.remote-ip=23.251.234.53
Authentication-Results: mx.cloudflare.net;
\tdkim=pass header.d=95270.cc.cd header.s=resend header.b=JPqCTZZB;
\tdkim=pass header.d=amazonses.com header.s=zh4gjftm6etwoq6afzugpky45synznly header.b=d8suBF47;
\tdmarc=pass header.from=95270.cc.cd policy.dmarc=none;
\tspf=pass (mx.cloudflare.net: domain of postmaster@e234-53.smtp-out.ap-northeast-1.amazonses.com designates 23.251.234.53 as permitted sender) smtp.helo=e234-53.smtp-out.ap-northeast-1.amazonses.com;
\tspf=pass (mx.cloudflare.net: domain of 010601a10a927f10-8e69e9ce-3fd0-4871-aec7-2e2141cce5e8-000000@send.95270.cc.cd designates 23.251.234.53 as permitted sender) smtp.mailfrom=010601a10a927f10-8e69e9ce-3fd0-4871-aec7-2e2141cce5e8-000000@send.95270.cc.cd;
\tarc=none smtp.remote-ip=23.251.234.53
Received-SPF: pass (mx.cloudflare.net: domain of 010601a10a927f10-8e69e9ce-3fd0-4871-aec7-2e2141cce5e8-000000@send.95270.cc.cd designates 23.251.234.53 as permitted sender)
\treceiver=mx.cloudflare.net; client-ip=23.251.234.53; envelope-from="010601a10a927f10-8e69e9ce-3fd0-4871-aec7-2e2141cce5e8-000000@send.95270.cc.cd"; helo=e234-53.smtp-out.ap-northeast-1.amazonses.com;
Subject: 认证头探针测试-95270
From: ai@95270.cc.cd
To: admin@1206201.xyz

这是一封测试邮件的正文。`;

describe('auth-results-utils.parse —— 实测样本', () => {
	const r = authResultsUtils.parse(REAL_SAMPLE);

	it('识别主来源为 mx.cloudflare.net', () => {
		expect(r).not.toBeNull();
		expect(r.source).toBe('mx.cloudflare.net');
	});

	it('SPF 结果与细节', () => {
		expect(r.spf.result).toBe('pass');
		expect(r.spf.ip).toBe('23.251.234.53');
		expect(r.spf.mailfrom).toBe('010601a10a927f10-8e69e9ce-3fd0-4871-aec7-2e2141cce5e8-000000@send.95270.cc.cd');
		expect(r.spf.helo).toBe('e234-53.smtp-out.ap-northeast-1.amazonses.com');
	});

	it('DKIM 两个签名均解析', () => {
		expect(r.dkim).toHaveLength(2);
		expect(r.dkim[0]).toEqual({ result: 'pass', domain: '95270.cc.cd', selector: 'resend' });
		expect(r.dkim[1]).toEqual({ result: 'pass', domain: 'amazonses.com', selector: 'zh4gjftm6etwoq6afzugpky45synznly' });
	});

	it('DMARC 结果与策略', () => {
		expect(r.dmarc.result).toBe('pass');
		expect(r.dmarc.from).toBe('95270.cc.cd');
		expect(r.dmarc.policy).toBe('none');
	});

	it('ARC 与发件 IP', () => {
		expect(r.arc).toBe('none');
		expect(r.remoteIp).toBe('23.251.234.53');
	});

	it('保留认证头原文', () => {
		expect(r.raw).toContain('Authentication-Results: mx.cloudflare.net;');
		expect(r.raw).toContain('Received-SPF: pass');
	});
});

describe('auth-results-utils.parse —— 边界场景', () => {
	it('无任何认证头时返回 null', () => {
		const raw = 'Subject: hello\nFrom: a@b.c\nTo: d@e.f\n\nbody';
		expect(authResultsUtils.parse(raw)).toBeNull();
	});

	it('空输入返回 null', () => {
		expect(authResultsUtils.parse('')).toBeNull();
		expect(authResultsUtils.parse(null)).toBeNull();
	});

	it('只有 Received-SPF 时兜底解析', () => {
		const raw = `Received-SPF: softfail (mx.cloudflare.net: domain of example.com does not designate 1.2.3.4 as permitted sender)
\treceiver=mx.cloudflare.net; client-ip=1.2.3.4; envelope-from="bounce@example.com"; helo=mail.example.com;
Subject: t

body`;
		const r = authResultsUtils.parse(raw);
		expect(r).not.toBeNull();
		expect(r.spf.result).toBe('softfail');
		expect(r.spf.ip).toBe('1.2.3.4');
		expect(r.spf.mailfrom).toBe('bounce@example.com');
		expect(r.spf.helo).toBe('mail.example.com');
	});

	it('失败场景（spf=fail / dkim=fail / dmarc=fail）', () => {
		const raw = `Authentication-Results: mx.cloudflare.net;
\tdkim=fail (bad signature) header.d=evil.example header.s=s1;
\tdmarc=fail header.from=evil.example policy.dmarc=reject;
\tspf=fail (mx.cloudflare.net: domain of evil.example does not designate 5.6.7.8 as permitted sender) smtp.mailfrom=bounce@evil.example;
\tarc=none smtp.remote-ip=5.6.7.8
Subject: t

body`;
		const r = authResultsUtils.parse(raw);
		expect(r.spf.result).toBe('fail');
		expect(r.dkim[0]).toEqual({ result: 'fail', domain: 'evil.example', selector: 's1' });
		expect(r.dmarc.result).toBe('fail');
		expect(r.dmarc.policy).toBe('reject');
	});

	it('多个 Authentication-Results 时优先 Cloudflare', () => {
		const raw = `Authentication-Results: smtp.forwarder.example; spf=pass smtp.mailfrom=x@y.z;
Authentication-Results: mx.cloudflare.net; spf=fail smtp.mailfrom=x@y.z; dkim=pass header.d=y.z header.s=sel; dmarc=fail header.from=y.z
Subject: t

body`;
		const r = authResultsUtils.parse(raw);
		expect(r.source).toBe('mx.cloudflare.net');
		expect(r.spf.result).toBe('fail');
		expect(r.dkim).toHaveLength(1);
	});

	it('DKIM 无签名（neutral）也能解析', () => {
		const raw = `Authentication-Results: mx.cloudflare.net; dkim=neutral (no signature); spf=pass smtp.mailfrom=a@b.c
Subject: t

body`;
		const r = authResultsUtils.parse(raw);
		expect(r.dkim[0].result).toBe('neutral');
		expect(r.dkim[0].domain).toBe('');
	});

	it('DKIM 使用 header.i 形式（Gmail 风格）时也能提取域名', () => {
		const raw = `Authentication-Results: mx.cloudflare.net;
\tdkim=pass header.i=@gmail.com header.s=20230601 header.b=abc123;
\tdmarc=pass header.from=gmail.com policy.dmarc=none;
\tspf=pass (mx.cloudflare.net: domain of user@gmail.com designates 209.85.220.41 as permitted sender) smtp.mailfrom=user@gmail.com
Subject: t

body`;
		const r = authResultsUtils.parse(raw);
		expect(r.dkim[0]).toEqual({ result: 'pass', domain: 'gmail.com', selector: '20230601' });
	});

	it('折行头部的提取不丢失（折叠行合并）', () => {
		const raw = `Authentication-Results: mx.cloudflare.net;
\tspf=pass (mx.cloudflare.net: domain of a@b.c designates 9.9.9.9 as permitted
\tsender) smtp.mailfrom=a@b.c
Subject: t

body`;
		const r = authResultsUtils.parse(raw);
		expect(r.spf.result).toBe('pass');
		expect(r.spf.ip).toBe('9.9.9.9');
	});
});
