import { registerHashes } from "./commands/hashes.js";
import { registerKeys } from "./commands/keys.js";
import { registerLists } from "./commands/lists.js";
import { registerSets } from "./commands/sets.js";
import { registerStrings } from "./commands/strings.js";
import { registerZsets } from "./commands/zsets.js";
import { Keyspace } from "./keyspace.js";
import { LuaRunner } from "./lua.js";
import { checkArity, define, unknownCommand, type CommandTable, type Ctx } from "./registry.js";
import { OK, RedisError, wrongArgs, type Reply } from "./types.js";
import { parseIntArg } from "./util.js";

export interface EngineStats {
  commands: number;
  errors: number;
  byCommand: Record<string, number>;
}

/** Embedded single-threaded Redis-compatible engine. Commands execute atomically. */
export class RedisEngine {
  readonly db = new Keyspace();
  readonly table: CommandTable = new Map();
  readonly lua = new LuaRunner();
  readonly stats: EngineStats = { commands: 0, errors: 0, byCommand: {} };
  private sweeper?: NodeJS.Timeout;

  constructor(opts: { now?: () => number; sweepIntervalMs?: number } = {}) {
    if (opts.now) this.db.now = opts.now;
    registerKeys(this.table);
    registerStrings(this.table);
    registerHashes(this.table);
    registerLists(this.table);
    registerSets(this.table);
    registerZsets(this.table);
    this.registerScripting();
    if (opts.sweepIntervalMs) {
      this.sweeper = setInterval(() => this.db.sweep(), opts.sweepIntervalMs);
      this.sweeper.unref();
    }
  }

  close(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /** Execute one command given as raw arguments (command name first). */
  exec(argv: string[], inScript = false): Reply {
    if (argv.length === 0) throw new RedisError("ERR empty command");
    const name = argv[0]!.toUpperCase();
    const spec = this.table.get(name);
    this.stats.commands++;
    this.stats.byCommand[name] = (this.stats.byCommand[name] ?? 0) + 1;
    try {
      if (!spec) throw unknownCommand(argv[0]!, argv.slice(1));
      if (inScript && ["EVAL", "EVALSHA", "EVAL_RO", "EVALSHA_RO", "SCRIPT"].includes(name)) {
        throw new RedisError("ERR This Redis command is not allowed from script");
      }
      checkArity(name, spec, argv.length);
      const ctx: Ctx = { db: this.db, inScript, call: (a) => this.exec(a, true) };
      return spec.run(ctx, argv.slice(1));
    } catch (e) {
      this.stats.errors++;
      throw e;
    }
  }

  isWrite(name: string): boolean {
    return this.table.get(name.toUpperCase())?.write ?? false;
  }

  private registerScripting(): void {
    const t = this.table;
    const evalArgs = (a: string[]) => {
      const n = parseIntArg(a[1]!);
      if (n < 0) throw new RedisError("ERR Number of keys can't be negative");
      if (n > a.length - 2) throw new RedisError("ERR Number of keys can't be greater than number of args");
      return { keys: a.slice(2, 2 + n), argv: a.slice(2 + n) };
    };
    const evalBody = (_c: Ctx, a: string[]) => {
      const sha = this.lua.load(a[0]!);
      const { keys, argv } = evalArgs(a);
      return this.lua.run(sha, keys, argv, (x) => this.exec(x, true));
    };
    const evalSha = (_c: Ctx, a: string[]) => {
      const sha = a[0]!.toLowerCase();
      const { keys, argv } = evalArgs(a);
      return this.lua.run(sha, keys, argv, (x) => this.exec(x, true));
    };
    define(t, "EVAL", -3, evalBody, true);
    define(t, "EVAL_RO", -3, evalBody);
    define(t, "EVALSHA", -3, evalSha, true);
    define(t, "EVALSHA_RO", -3, evalSha);
    define(t, "SCRIPT", -2, (_c, a) => {
      const sub = a[0]!.toUpperCase();
      if (sub === "LOAD") {
        if (a.length !== 2) throw wrongArgs("script|load");
        return this.lua.load(a[1]!);
      }
      if (sub === "EXISTS") return a.slice(1).map((s) => (this.lua.scripts.has(s.toLowerCase()) ? 1 : 0));
      if (sub === "FLUSH") { this.lua.flush(); return OK; }
      throw new RedisError(`ERR unknown subcommand '${a[0]}'. Try SCRIPT HELP.`);
    });
  }
}
