import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import stage1App, { isStage1Running } from '../../stage1/src/server.js';
import stage2App from './server.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use('/', stage1App); // retains /scrape & /health
app.use('/', stage2App); // keeps /stage2/*

app.get('/unified/health', (_req, res) => {
  res.json({
    ok: true,
    stage1: { running: isStage1Running() },
    stage2: { note: 'See /stage2/health and /stage2/jobs/:jobId' },
    time: new Date().toISOString()
  });
});

const PORT = process.env.UNIFIED_PORT || process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`[unified] server listening on ${PORT}`);
  console.log(`[unified] Stage1: POST /scrape, GET /health`);
  console.log(`[unified] Stage2: /stage2/health, /stage2/scrape-batch, /stage2/scrape-multi, /stage2/jobs/:jobId`);
  console.log(`[unified] Aggregate: /unified/health`);
});
