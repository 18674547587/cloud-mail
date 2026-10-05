import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/divide-send.spec.js', 'test/auth-results.spec.js'],
	},
});
