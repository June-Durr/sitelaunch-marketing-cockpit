import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
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
