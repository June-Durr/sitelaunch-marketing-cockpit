import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    /*
     * Twenty two migrations, applied to a real Postgres in WebAssembly, in
     * eight separate database test files that run alongside the jsdom ones.
     *
     * The default five seconds was fine when there were eleven migrations and
     * fewer files. Raised to thirty when there were fifteen, and raised again
     * here: src/test/screens.test.tsx runs in under four seconds on its own and
     * was timing out at thirty three inside the full suite, which is starvation
     * rather than a hang. Raised rather than papered over with retries, which
     * would hide a real one.
     *
     * The real fix is to stop eight WebAssembly databases competing with the
     * browser tests for the same workers, which is a change to how the suite is
     * partitioned and not something to do in the middle of a feature.
     */
    testTimeout: 60_000,
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
