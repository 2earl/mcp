import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  // Tests run against exactly the schema production gets.
  const migrations = await readD1Migrations('./migrations');

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
          // login isn't running in tests: token validation is a stand-in (test/helpers.ts).
          // Services behind the gateway are stand-ins too (test/helpers.ts fakeUpstream), passed
          // per test; the production binding only has to exist.
          serviceBindings: {
            AUTH_SERVER: () => new Response('not in tests', { status: 500 }),
            PROMPTSHARE: () => new Response('not in tests', { status: 500 }),
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/apply-migrations.ts'] },
  };
});
