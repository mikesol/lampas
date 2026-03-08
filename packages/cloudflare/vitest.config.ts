import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		exclude: ["src/e2e/**", "**/node_modules/**", "**/dist/**"],
		poolOptions: {
			workers: {
				isolatedStorage: false,
				wrangler: { configPath: "./wrangler.toml" },
			},
		},
	},
});
