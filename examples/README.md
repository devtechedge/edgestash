# Examples

Plain scripts that use the official SDKs exactly as their docs show. Nothing imports edgestash.

```bash
docker compose up -d     # or: pnpm install && pnpm build && pnpm start   (repo root)
cd examples && npm install
npm run blob
npm run redis
npm run ratelimit
```
