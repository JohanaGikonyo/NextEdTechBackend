# NestJS on Cloudflare Workers — Setup Guide

This guide explains how to run your existing NestJS backend on Cloudflare Workers using a Hono adapter.

## What changed and why

NestJS is built for Node.js and uses Express (or Fastify) as its HTTP layer. Cloudflare Workers is a V8-based runtime — there is no `http.Server`, no `child_process`, no `fs` filesystem access. A standard `NestFactory.create(AppModule)` + `app.listen(3000)` will not work.

The solution: replace the Express adapter with a **Hono adapter**. Hono is a web framework designed for the Workers runtime. The custom `HonoAdapter` class bridges NestJS's route registration to Hono's fetch-based handler.

## Files in this setup

| File | Purpose |
|------|---------|
| `wrangler.jsonc` | Workers config — enables `nodejs_compat`, aliases Node-only NestJS packages to no-ops |
| `src/main.ts` | Worker entry point — bootstraps NestJS with the Hono adapter, exports the Hono app |
| `src/hono-adapter.ts` | Custom NestJS `AbstractHttpAdapter` backed by Hono |
| `src/noop-module.js` | Empty module to stub out `@nestjs/microservices`, `@nestjs/websockets`, `express` |

## Install Hono

```bash
npm install hono
```

## What works and what doesn't

### ✅ Works
- Controllers, services, providers (dependency injection)
- Guards, interceptors, pipes, filters
- DTOs with `class-validator` / `class-transformer`
- `@Body()`, `@Param()`, `@Query()`, `@Headers()` decorators
- Global pipes, guards, interceptors
- D1, R2, KV, Durable Objects bindings (via `wrangler.jsonc`)

### ❌ Not supported on Workers
- **Microservices** (`@nestjs/microservices`) — aliased to no-op
- **WebSockets / Gateways** (`@nestjs/websockets`) — aliased to no-op
- **Express middleware** (`app.use(someExpressMiddleware)`) — use Hono middleware instead
- **Static file serving** (`app.useStaticAssets()`) — use the Workers `assets` binding
- **Template rendering** (`app.setViewEngine()`) — not available
- **`app.listen(port)`** — no-op (Workers handles HTTP via the fetch handler)

## CORS

If your existing code uses `app.enableCors()`, replace it with Hono's CORS middleware:

```ts
import { cors } from "hono/cors";

// In main.ts, before app.init():
const honoApp = app.getHttpAdapter().getInstance() as Hono;
honoApp.use("*", cors());
```

## Environment variables

On Workers, environment variables are bindings, not `process.env`. Access them via the `env` object passed to the fetch handler. If your NestJS code reads `process.env`, `nodejs_compat` polyfills it, but the values come from `wrangler.jsonc` bindings or dashboard Settings > Variables & Secrets.

## Deploy command

In your Workers Builds settings (Settings > Build), set:
- **Build command:** `npm run build` (if you have a build step) or leave empty
- **Deploy command:** `npx wrangler deploy`

Do NOT put build commands in `wrangler.jsonc` — Workers Builds ignores the `[build]` section.
