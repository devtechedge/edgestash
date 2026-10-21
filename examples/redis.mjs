// Stock @upstash/redis code. Redis.fromEnv() reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
await redis.set("user:42", { name: "Ada", plan: "pro" }, { ex: 60 });
console.log("get     ", await redis.get("user:42"));
console.log("incr    ", await redis.incr("visits"));
await redis.zadd("scores", { score: 90, member: "ada" }, { score: 75, member: "bob" });
console.log("zrange  ", await redis.zrange("scores", 0, -1, { rev: true, withScores: true }));
const p = redis.pipeline();
p.hset("session:1", { ua: "example" });
p.expire("session:1", 30);
p.ttl("session:1");
console.log("pipeline", await p.exec());
console.log("eval    ", await redis.eval("return redis.call('INCRBY', KEYS[1], ARGV[1])", ["visits"], [10]));
