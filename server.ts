import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { initSchema } from './src/server/db.ts';
import { seedDatabaseIfEmpty } from './src/server/seed.ts';
import { coreRouter } from './src/server/routes-core.ts';
import { financeRouter } from './src/server/routes-finance.ts';
import { inventoryRouter } from './src/server/routes-inventory.ts';

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

async function startServer() {
  initSchema();
  seedDatabaseIfEmpty();

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'nextgen-erp', timestamp: new Date().toISOString() });
  });

  app.use('/api', coreRouter);
  app.use('/api', financeRouter);
  app.use('/api', inventoryRouter);

  if (IS_PROD) {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`NEXTGEN ERP server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start NEXTGEN ERP server:', err);
  process.exit(1);
});
