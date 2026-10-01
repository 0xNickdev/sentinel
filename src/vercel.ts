import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from './app.js';

// One Fastify instance per warm serverless container; Vercel rewrites every /api/* request here.
const ready = buildApp().then(async (app) => {
  await app.ready();
  return app;
});

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await ready;
  app.server.emit('request', req, res);
}
