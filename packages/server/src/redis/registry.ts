import type { Keyspace } from "./keyspace.js";
import { RedisError, wrongArgs, type Reply } from "./types.js";

export interface Ctx {
  db: Keyspace;
  /** Execute a nested command (used by scripting). */
  call(args: string[]): Reply;
  /** True while running inside EVAL. */
  inScript: boolean;
}

export interface CommandSpec {
  /** Redis arity: positive = exact, negative = minimum (includes command name). */
  arity: number;
  write?: boolean;
  run(ctx: Ctx, args: string[]): Reply;
}

export type CommandTable = Map<string, CommandSpec>;

export function define(table: CommandTable, name: string, arity: number, run: CommandSpec["run"], write = false): void {
  table.set(name.toUpperCase(), { arity, run, write });
}

export function checkArity(name: string, spec: CommandSpec, argc: number): void {
  if ((spec.arity > 0 && argc !== spec.arity) || (spec.arity < 0 && argc < -spec.arity)) {
    throw wrongArgs(name);
  }
}

export function unknownCommand(name: string, args: string[]): RedisError {
  const preview = args.slice(0, 20).map((a) => `'${a}'`).join(" ");
  return new RedisError(`ERR unknown command '${name}', with args beginning with: ${preview}${preview ? " " : ""}`);
}
