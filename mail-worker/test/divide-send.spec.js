/**
 * 针对「分别发送（manyType = 'divide'）」的单元测试
 *
 * 验证目标：
 *  1. 分别发送（站外、无附件）→ 走 batch，每封 to 只含一个收件人，DB 每封一条记录且 recipient 只含自己
 *  2. 分别发送（站外、带附件）→ 逐封单发（batch 不支持附件）
 *  3. 合并发送（默认）→ 单封邮件，to 为全部收件人（保持原有行为）
 *  4. 站内互发 + 分别发送 → 不调用 Resend，收件记录 recipient 只含自己
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
	inserted: [],
	sendCalls: [],
	batchCalls: [],
	accounts: [],
	roles: [],
	settings: {},
}));

vi.mock('resend', () => {
	class Resend {
		constructor() {
			this.emails = {
				send: async (form) => {
					h.sendCalls.push(form);
					return { data: { id: 'em_single_' + h.sendCalls.length }, error: null };
				}
			};
			this.batch = {
				send: async (forms) => {
					h.batchCalls.push(forms);
					return { data: { data: forms.map((f, i) => ({ id: 'em_batch_' + i })) }, error: null };
				}
			};
		}
	}
	return { Resend };
});

vi.mock('../src/entity/orm', () => ({
	default: () => ({
		insert: () => ({
			values: (v) => ({
				returning: () => ({
					get: async () => {
						const row = { ...v, emailId: h.inserted.length + 1 };
						h.inserted.push(row);
						return row;
					}
				}),
				run: async () => {}
			})
		}),
		select: () => ({
			from: () => ({
				where: () => ({
					all: async () => h.accounts,
					get: async () => null
				}),
				leftJoin: () => ({ where: () => ({ all: async () => [], get: async () => null }) })
			})
		}),
		update: () => ({ set: () => ({ where: () => ({ run: async () => {} }) }) }),
		delete: () => ({ where: () => ({ run: async () => {} }) })
	})
}));

vi.mock('../src/entity/email', () => ({ default: { __table: 'email' } }));
vi.mock('../src/entity/att', () => ({ att: { __table: 'att' } }));
vi.mock('../src/entity/account', () => ({ default: { __table: 'account' } }));
vi.mock('../src/entity/user', () => ({ default: { __table: 'user' } }));
vi.mock('../src/entity/star', () => ({ star: { __table: 'star' } }));

vi.mock('../src/const/entity-const', () => ({
	emailConst: {
		type: { SEND: 1, RECEIVE: 0 },
		status: { RECEIVE: 0, SENT: 1, DELIVERED: 2, BOUNCED: 3, COMPLAINED: 4, DELAYED: 5, SAVING: 6, NOONE: 7, FAILED: 8 },
		unread: { UNREAD: 0, READ: 1 }
	},
	attConst: { type: { ATT: 0, EMBED: 1 } },
	isDel: { NORMAL: 0, DELETE: 1 },
	settingConst: { send: { CLOSE: 0, OPEN: 1 }, noRecipient: { CLOSE: 0, OPEN: 1 } }
}));

vi.mock('../src/const/kv-const', () => ({ default: { SEND_DAY_COUNT: 'send_day_count:' } }));

vi.mock('../src/error/biz-error', () => ({
	default: class BizError extends Error {
		constructor(message, code) {
			super(message);
			this.code = code;
		}
	}
}));

vi.mock('../src/i18n/i18n', () => ({
	t: (key, values) => (values ? key + ':' + JSON.stringify(values) : key)
}));

vi.mock('../src/utils/email-utils', () => ({
	default: {
		getDomain: (email) => String(email).split('@')[1],
		getName: (email) => String(email).split('@')[0]
	}
}));

vi.mock('../src/utils/domain-uitls', () => ({ default: { toOssDomain: (d) => d } }));
vi.mock('../src/utils/file-utils', () => ({ default: { formatSize: (s) => String(s) + 'B' } }));

vi.mock('../src/service/setting-service', () => ({
	default: { query: async () => h.settings }
}));

vi.mock('../src/service/account-service', () => ({
	default: {
		selectById: async () => ({ accountId: 1, userId: 1, email: 'sender@test.com', allReceive: 0 })
	}
}));

vi.mock('../src/service/user-service', () => ({
	default: {
		selectById: async () => ({ userId: 1, email: 'sender@test.com', type: 1, sendCount: 0 }),
		incrUserSendCount: async () => {}
	}
}));

vi.mock('../src/service/role-service', () => ({
	default: {
		selectById: async () => ({ sendType: 'all', sendCount: 0, availDomain: [], banEmail: [] }),
		selectByUserIds: async () => h.roles,
		hasAvailDomainPerm: () => true,
		isBanEmail: () => false
	}
}));

vi.mock('../src/service/att-service', () => ({
	default: {
		toImageUrlHtml: async (c, content) => ({ imageDataList: [], html: content }),
		saveArticleAtt: async () => {},
		saveSendAtt: async () => {},
		selectByEmailIds: async () => []
	}
}));

vi.mock('../src/service/star-service', () => ({ default: {} }));
vi.mock('../src/service/telegram-service', () => ({ default: {} }));

const emailService = (await import('../src/service/email-service.js')).default;

const ctx = {
	env: {
		admin: 'admin@test.com',
		kv: { get: async () => null, put: async () => {} }
	},
	req: { url: 'https://m.example.com/api/email/send' }
};

const baseParams = (over = {}) => ({
	accountId: 1,
	name: 'Sender',
	sendType: '',
	emailId: 0,
	receiveEmail: ['x@other.com', 'y@other.com'],
	manyType: null,
	text: 'hello',
	content: '<p>hello</p>',
	subject: 'test subject',
	attachments: [],
	...over
});

beforeEach(() => {
	h.inserted.length = 0;
	h.sendCalls.length = 0;
	h.batchCalls.length = 0;
	h.accounts = [];
	h.roles = [];
	h.settings = {
		resendTokens: { 'test.com': 're_fake_token' },
		r2Domain: 'https://r2.example.com',
		send: 1,
		domainList: ['@test.com'],
		noRecipient: 1
	};
});

describe('合并发送（默认行为，回归保护）', () => {
	it('一封邮件带全部收件人，recipient 记录全部收件人', async () => {
		await emailService.send(ctx, baseParams(), 1);

		expect(h.sendCalls).toHaveLength(1);
		expect(h.batchCalls).toHaveLength(0);
		expect(h.sendCalls[0].to).toEqual(['x@other.com', 'y@other.com']);

		expect(h.inserted).toHaveLength(1);
		expect(JSON.parse(h.inserted[0].recipient)).toEqual([
			{ address: 'x@other.com', name: '' },
			{ address: 'y@other.com', name: '' }
		]);
	});
});

describe('分别发送（站外，无附件）', () => {
	it('每个收件人单独一封，to 只含自己，DB 每封一条且 recipient 只含自己', async () => {
		const result = await emailService.send(ctx, baseParams({ manyType: 'divide' }), 1);

		// 用 batch 一次提交，但每封邮件的 to 只含一个收件人
		expect(h.sendCalls).toHaveLength(0);
		expect(h.batchCalls).toHaveLength(1);
		expect(h.batchCalls[0]).toHaveLength(2);
		expect(h.batchCalls[0][0].to).toEqual(['x@other.com']);
		expect(h.batchCalls[0][1].to).toEqual(['y@other.com']);

		// 每封单独一条已发送记录，recipient 只含自己（关键：收件人互相看不到）
		expect(h.inserted).toHaveLength(2);
		expect(JSON.parse(h.inserted[0].recipient)).toEqual([{ address: 'x@other.com', name: '' }]);
		expect(JSON.parse(h.inserted[1].recipient)).toEqual([{ address: 'y@other.com', name: '' }]);
		expect(h.inserted[0].resendEmailId).toBe('em_batch_0');
		expect(h.inserted[1].resendEmailId).toBe('em_batch_1');

		// 返回数组，前端会逐条加入「已发送」列表
		expect(result).toHaveLength(2);
	});
});

describe('分别发送（站外，带附件）', () => {
	it('batch 不支持附件，改为逐封单发，to 仍只含自己', async () => {
		await emailService.send(ctx, baseParams({
			manyType: 'divide',
			attachments: [{ filename: 'a.txt', content: 'eHh4', size: 3 }]
		}), 1);

		expect(h.batchCalls).toHaveLength(0);
		expect(h.sendCalls).toHaveLength(2);
		expect(h.sendCalls[0].to).toEqual(['x@other.com']);
		expect(h.sendCalls[1].to).toEqual(['y@other.com']);
		expect(h.sendCalls[0].attachments).toHaveLength(1);

		expect(h.inserted).toHaveLength(2);
		expect(JSON.parse(h.inserted[0].recipient)).toEqual([{ address: 'x@other.com', name: '' }]);
	});
});

describe('分别发送（只有一个收件人）', () => {
	it('退化为普通发送，不拆分', async () => {
		await emailService.send(ctx, baseParams({ manyType: 'divide', receiveEmail: ['x@other.com'] }), 1);

		expect(h.batchCalls).toHaveLength(0);
		expect(h.sendCalls).toHaveLength(1);
		expect(h.inserted).toHaveLength(1);
	});
});

describe('站内互发 + 分别发送', () => {
	it('不走 Resend，收件记录 recipient 只含自己', async () => {
		h.accounts = [
			{ accountId: 11, userId: 11, email: 'u1@test.com' },
			{ accountId: 12, userId: 12, email: 'u2@test.com' }
		];
		h.roles = [
			{ userId: 11, banEmail: [], availDomain: [] },
			{ userId: 12, banEmail: [], availDomain: [] }
		];

		await emailService.send(ctx, baseParams({
			manyType: 'divide',
			receiveEmail: ['u1@test.com', 'u2@test.com']
		}), 1);

		// 全站内：不调用第三方
		expect(h.sendCalls).toHaveLength(0);
		expect(h.batchCalls).toHaveLength(0);

		// 1 条发件记录 + 2 条收件记录
		expect(h.inserted).toHaveLength(3);

		const receiveRows = h.inserted.filter(r => r.type === 0);
		expect(receiveRows).toHaveLength(2);
		expect(JSON.parse(receiveRows[0].recipient)).toEqual([{ address: 'u1@test.com', name: '' }]);
		expect(JSON.parse(receiveRows[1].recipient)).toEqual([{ address: 'u2@test.com', name: '' }]);
		expect(receiveRows[0].toEmail).toBe('u1@test.com');
	});
});

describe('站内互发 + 合并发送（回归保护）', () => {
	it('收件记录保留全部收件人（与合并发送语义一致）', async () => {
		h.accounts = [
			{ accountId: 11, userId: 11, email: 'u1@test.com' },
			{ accountId: 12, userId: 12, email: 'u2@test.com' }
		];
		h.roles = [
			{ userId: 11, banEmail: [], availDomain: [] },
			{ userId: 12, banEmail: [], availDomain: [] }
		];

		await emailService.send(ctx, baseParams({ receiveEmail: ['u1@test.com', 'u2@test.com'] }), 1);

		const receiveRows = h.inserted.filter(r => r.type === 0);
		expect(receiveRows).toHaveLength(2);
		expect(JSON.parse(receiveRows[0].recipient)).toEqual([
			{ address: 'u1@test.com', name: '' },
			{ address: 'u2@test.com', name: '' }
		]);
	});
});
