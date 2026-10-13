import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    /*
     * Fifteen migrations, applied to a real Postgres in WebAssembly, in seven
     * separate database test files that run alongside the jsdom ones. The
     * default five seconds was fine when there were eleven; under the
     * contention that now exists a passing test can take longer than that and
     * fail for no reason anybody can act on. Raised rather than papered over
     * with retries, which would hide a genuine hang.
     */
    testTimeout: 30_000,
    hookTimeout: 180_000,
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    /**
     * The screen tests exercise the browser-local adapter and its seed data.
     *
     * Vitest loads .env.local like any other Vite process, so once a developer
     * has real Supabase credentials on disk, supabaseConfigured turns true, the
     * Supabase adapter is selected, every screen renders an empty dataset and
     * nine tests fail for a reason that has nothing to do with the code. Blanking
     * the two variables here makes the suite depend on the repository alone.
     */
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
  },
});
