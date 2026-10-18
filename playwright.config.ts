import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:4187', browserName: 'chromium' },
  webServer: {
    command: 'python3 -m http.server 4187 --bind 127.0.0.1 --directory dist',
    url: 'http://127.0.0.1:4187/fundamentals/sql-overview/',
    reuseExistingServer: false,
  },
});
