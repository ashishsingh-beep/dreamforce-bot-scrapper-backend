import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import stage1App, { isStage1Running } from './stage1/src/server.js';
import stage2App from './stage2/src/server.js';

// Create a parent app
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Mount Stage1 at root (backward compatible: /scrape, /health)
app.use('/', stage1App);
// Stage2 already namespaces its routes with /stage2
app.use('/', stage2App);

// Unified health endpoint
app.get('/unified/health', (_req, res) => {
  res.json({
    ok: true,
    stage1: { running: isStage1Running() },
    stage2: { note: 'See /stage2/health and /stage2/jobs/:id' },
    time: new Date().toISOString()
  });
});

const PORT = process.env.UNIFIED_PORT || process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`[unified] server listening on ${PORT}`);
  console.log(`[unified] Stage1 endpoints: POST /scrape, GET /health`);
  console.log(`[unified] Stage2 endpoints: GET /stage2/health, POST /stage2/scrape-batch, POST /stage2/scrape-multi, GET /stage2/jobs/:jobId`);
  console.log(`[unified] Aggregate health: GET /unified/health`);
});
