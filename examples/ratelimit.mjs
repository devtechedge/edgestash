// Stock @upstash/ratelimit code running its Lua scripts on edgestash.
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const ratelimit = new Ratelimit({ redis: Redis.fromEnv(), limiter: Ratelimit.slidingWindow(3, "10 s"), prefix: "example" });
for (let i = 1; i <= 5; i++) {
  const { success, remaining, reset } = await ratelimit.limit("api-key-123");
  console.log(`request ${i}: ${success ? "allowed" : "blocked"}, remaining ${remaining}, resets ${new Date(reset).toISOString()}`);
}
