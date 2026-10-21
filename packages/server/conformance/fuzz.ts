/** Seeded random command generator over a tiny keyspace to shake out divergences. */
export function fuzzCommands(n: number, seed: number): string[][] {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const keys = ["k1", "k2", "k3", "k4"];
  const vals = ["a", "b", "c", "1", "2", "-3", "10", ""];
  const num = () => String(Math.floor(rnd() * 21) - 10);
  const gens: Array<() => string[]> = [
    () => ["SET", pick(keys), pick(vals)], () => ["GET", pick(keys)], () => ["INCR", pick(keys)], () => ["INCRBY", pick(keys), num()],
    () => ["APPEND", pick(keys), pick(vals)], () => ["DEL", pick(keys)], () => ["EXISTS", pick(keys), pick(keys)], () => ["TYPE", pick(keys)],
    () => ["HSET", pick(keys), pick(vals), pick(vals)], () => ["HGET", pick(keys), pick(vals)], () => ["HDEL", pick(keys), pick(vals)], () => ["HINCRBY", pick(keys), pick(vals), num()], () => ["HGETALL", pick(keys)], () => ["HLEN", pick(keys)],
    () => ["LPUSH", pick(keys), pick(vals)], () => ["RPUSH", pick(keys), pick(vals), pick(vals)], () => ["LPOP", pick(keys)], () => ["RPOP", pick(keys)], () => ["LRANGE", pick(keys), num(), num()], () => ["LLEN", pick(keys)], () => ["LREM", pick(keys), num(), pick(vals)], () => ["LINDEX", pick(keys), num()], () => ["LTRIM", pick(keys), num(), num()],
    () => ["SADD", pick(keys), pick(vals), pick(vals)], () => ["SREM", pick(keys), pick(vals)], () => ["SMEMBERS", pick(keys)], () => ["SCARD", pick(keys)], () => ["SISMEMBER", pick(keys), pick(vals)], () => ["SINTER", pick(keys), pick(keys)], () => ["SUNION", pick(keys), pick(keys)],
    () => ["ZADD", pick(keys), num(), pick(vals)], () => ["ZINCRBY", pick(keys), num(), pick(vals)], () => ["ZRANGE", pick(keys), num(), num(), "WITHSCORES"], () => ["ZRANGEBYSCORE", pick(keys), num(), "+inf"], () => ["ZREM", pick(keys), pick(vals)], () => ["ZCARD", pick(keys)], () => ["ZRANK", pick(keys), pick(vals)], () => ["ZSCORE", pick(keys), pick(vals)], () => ["ZPOPMIN", pick(keys)],
    () => ["EXPIRE", pick(keys), String(Math.floor(rnd() * 1000) + 100)], () => ["TTL", pick(keys)], () => ["PERSIST", pick(keys)], () => ["RENAME", pick(keys), pick(keys)], () => ["STRLEN", pick(keys)], () => ["GETRANGE", pick(keys), num(), num()],
  ];
  return Array.from({ length: n }, () => pick(gens)());
}
