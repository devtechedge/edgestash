/** Reply model shared by the engine, the REST layer and the Lua bridge. */
export class Status {
  constructor(public readonly value: string) {}
}
export class RedisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisError";
  }
}
export type Reply = string | number | bigint | null | Status | Reply[];

export const OK = new Status("OK");
export const WRONGTYPE = "WRONGTYPE Operation against a key holding the wrong kind of value";
export const NOT_INT = "ERR value is not an integer or out of range";
export const NOT_FLOAT = "ERR value is not a valid float";
export const SYNTAX = "ERR syntax error";

export const wrongArgs = (cmd: string) =>
  new RedisError(`ERR wrong number of arguments for '${cmd.toLowerCase()}' command`);

export type ZSet = { scores: Map<string, number> };
export type Value =
  | { type: "string"; value: string }
  | { type: "hash"; value: Map<string, string> }
  | { type: "list"; value: string[] }
  | { type: "set"; value: Set<string> }
  | { type: "zset"; value: Map<string, number> };

export type Entry = Value & { expireAt?: number };
