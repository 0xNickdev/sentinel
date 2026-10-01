import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { config } from './config.js';

// Local dev: API + the landing page from public/ (on Vercel, public/ is served by the CDN).
const app = await buildApp();
await app.register(fastifyStatic, { root: fileURLToPath(new URL('../public', import.meta.url)) });
await app.listen({ port: config.port, host: config.host });
