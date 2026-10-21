import { createHash } from "node:crypto";
import fengari from "fengari";
import { RedisError, Status, type Reply } from "./types.js";

const { lua, lauxlib, lualib, to_luastring } = fengari;

export const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** Format a Lua number the way Redis turns it into a command argument (%.17g-ish, integers plain). */
function luaNumberArg(n: number): string {
  if (Number.isInteger(n)) return n.toFixed(0);
  return String(Number(n.toPrecision(17)));
}

/**
 * Lua 5.3 VM (fengari) exposing the Redis scripting API used by @upstash/ratelimit and
 * typical EVAL scripts: redis.call, redis.pcall, redis.error_reply, redis.status_reply,
 * redis.sha1hex, redis.log, plus a Lua 5.1 style global `unpack`.
 */
export class LuaRunner {
  private L: any;
  private loaded = new Set<string>();
  readonly scripts = new Map<string, string>();
  private caller: ((args: string[]) => Reply) | null = null;

  constructor() {
    const L = (this.L = lauxlib.luaL_newstate());
    lualib.luaL_openlibs(L);
    for (const lib of ["io", "os", "package", "debug"]) {
      lua.lua_pushnil(L);
      lua.lua_setglobal(L, to_luastring(lib));
    }
    lua.lua_pushnil(L);
    lua.lua_setglobal(L, to_luastring("require"));
    lua.lua_pushnil(L);
    lua.lua_setglobal(L, to_luastring("dofile"));
    lua.lua_pushnil(L);
    lua.lua_setglobal(L, to_luastring("loadfile"));
    // Lua 5.1 compatibility used by Redis scripts.
    lua.lua_getglobal(L, to_luastring("table"));
    lua.lua_getfield(L, -1, to_luastring("unpack"));
    lua.lua_setglobal(L, to_luastring("unpack"));
    lua.lua_pop(L, 1);

    lua.lua_newtable(L);
    const fn = (name: string, f: (L: any) => number) => {
      lua.lua_pushjsfunction(L, f);
      lua.lua_setfield(L, -2, to_luastring(name));
    };
    fn("call", (L: any) => this.redisCall(L, true));
    fn("pcall", (L: any) => this.redisCall(L, false));
    fn("sha1hex", (L: any) => { lua.lua_pushstring(L, to_luastring(sha1(lua.lua_tojsstring(L, 1) ?? ""))); return 1; });
    fn("error_reply", (L: any) => { this.pushStatusTable(L, "err", lua.lua_tojsstring(L, 1) ?? ""); return 1; });
    fn("status_reply", (L: any) => { this.pushStatusTable(L, "ok", lua.lua_tojsstring(L, 1) ?? ""); return 1; });
    fn("log", () => 0);
    fn("setresp", () => 0);
    fn("set_repl", () => 0);
    fn("replicate_commands", (L: any) => { lua.lua_pushboolean(L, 1); return 1; });
    for (const [k, v] of [["LOG_DEBUG", 0], ["LOG_VERBOSE", 1], ["LOG_NOTICE", 2], ["LOG_WARNING", 3]] as const) {
      lua.lua_pushinteger(L, v);
      lua.lua_setfield(L, -2, to_luastring(k));
    }
    lua.lua_setglobal(L, to_luastring("redis"));
    lua.lua_newtable(L);
    lua.lua_setglobal(L, to_luastring("__edgestash_scripts"));
  }

  private pushStatusTable(L: any, field: string, msg: string): void {
    lua.lua_newtable(L);
    lua.lua_pushstring(L, to_luastring(msg));
    lua.lua_setfield(L, -2, to_luastring(field));
  }

  private redisCall(L: any, raise: boolean): number {
    const n = lua.lua_gettop(L);
    const args: string[] = [];
    for (let i = 1; i <= n; i++) {
      const t = lua.lua_type(L, i);
      if (t === lua.LUA_TNUMBER) args.push(luaNumberArg(lua.lua_tonumber(L, i)));
      else if (t === lua.LUA_TSTRING) args.push(lua.lua_tojsstring(L, i));
      else {
        this.pushStatusTable(L, "err", "ERR Lua redis lib command arguments must be strings or integers");
        return raise ? lua.lua_error(L) : 1;
      }
    }
    if (args.length === 0) {
      this.pushStatusTable(L, "err", "ERR Please specify at least one argument for this redis lib call");
      return raise ? lua.lua_error(L) : 1;
    }
    let reply: Reply;
    try {
      reply = this.caller!(args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.pushStatusTable(L, "err", msg);
      return raise ? lua.lua_error(L) : 1;
    }
    this.pushReply(L, reply);
    return 1;
  }

  private pushReply(L: any, r: Reply): void {
    if (r === null) lua.lua_pushboolean(L, 0);
    else if (typeof r === "string") lua.lua_pushstring(L, to_luastring(r));
    else if (typeof r === "number" || typeof r === "bigint") {
      const n = Number(r);
      if (Number.isInteger(n) && n >= -2147483648 && n <= 2147483647) lua.lua_pushinteger(L, n);
      else lua.lua_pushnumber(L, n);
    } else if (r instanceof Status) this.pushStatusTable(L, "ok", r.value);
    else {
      lua.lua_createtable(L, r.length, 0);
      r.forEach((item, i) => {
        this.pushReply(L, item);
        lua.lua_rawseti(L, -2, i + 1);
      });
    }
  }

  private toReply(L: any, idx: number): Reply {
    const t = lua.lua_type(L, idx);
    if (t === lua.LUA_TNUMBER) return Math.trunc(lua.lua_tonumber(L, idx));
    if (t === lua.LUA_TSTRING) return lua.lua_tojsstring(L, idx);
    if (t === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, idx) ? 1 : null;
    if (t === lua.LUA_TTABLE) {
      const abs = lua.lua_absindex(L, idx);
      lua.lua_getfield(L, abs, to_luastring("err"));
      if (lua.lua_type(L, -1) === lua.LUA_TSTRING) {
        const msg = lua.lua_tojsstring(L, -1);
        lua.lua_pop(L, 1);
        throw new RedisError(msg);
      }
      lua.lua_pop(L, 1);
      lua.lua_getfield(L, abs, to_luastring("ok"));
      if (lua.lua_type(L, -1) === lua.LUA_TSTRING) {
        const msg = lua.lua_tojsstring(L, -1);
        lua.lua_pop(L, 1);
        return new Status(msg);
      }
      lua.lua_pop(L, 1);
      const out: Reply[] = [];
      for (let i = 1; ; i++) {
        lua.lua_rawgeti(L, abs, i);
        if (lua.lua_type(L, -1) === lua.LUA_TNIL) { lua.lua_pop(L, 1); break; }
        try {
          out.push(this.toReply(L, -1));
        } finally {
          lua.lua_pop(L, 1);
        }
      }
      return out;
    }
    return null;
  }

  load(body: string): string {
    const sha = sha1(body);
    if (this.loaded.has(sha)) return sha;
    // Redis 7 accepts a "#!lua flags=..." shebang; Lua itself does not inside load().
    const src = body.startsWith("#!") ? body.replace(/^#![^\n]*/, "") : body;
    const L = this.L;
    lua.lua_getglobal(L, to_luastring("__edgestash_scripts"));
    const status = lauxlib.luaL_loadbuffer(L, to_luastring(src), null, to_luastring("@user_script"));
    if (status !== lua.LUA_OK) {
      const msg = lua.lua_tojsstring(L, -1);
      lua.lua_pop(L, 2);
      throw new RedisError(`ERR Error compiling script (new function): ${msg}`);
    }
    lua.lua_setfield(L, -2, to_luastring(sha));
    lua.lua_pop(L, 1);
    this.loaded.add(sha);
    this.scripts.set(sha, body);
    return sha;
  }

  flush(): void {
    const L = this.L;
    lua.lua_newtable(L);
    lua.lua_setglobal(L, to_luastring("__edgestash_scripts"));
    this.loaded.clear();
    this.scripts.clear();
  }

  run(sha: string, keys: string[], argv: string[], call: (args: string[]) => Reply): Reply {
    if (!this.loaded.has(sha)) throw new RedisError("NOSCRIPT No matching script. Please use EVAL.");
    const L = this.L;
    const setArr = (name: string, xs: string[]) => {
      lua.lua_createtable(L, xs.length, 0);
      xs.forEach((x, i) => { lua.lua_pushstring(L, to_luastring(x)); lua.lua_rawseti(L, -2, i + 1); });
      lua.lua_setglobal(L, to_luastring(name));
    };
    setArr("KEYS", keys);
    setArr("ARGV", argv);
    lua.lua_getglobal(L, to_luastring("__edgestash_scripts"));
    lua.lua_getfield(L, -1, to_luastring(sha));
    lua.lua_remove(L, -2);
    const prev = this.caller;
    this.caller = call;
    const base = lua.lua_gettop(L) - 1;
    try {
      const status = lua.lua_pcall(L, 0, 1, 0);
      if (status !== lua.LUA_OK) {
        let msg: string;
        if (lua.lua_type(L, -1) === lua.LUA_TTABLE) {
          lua.lua_getfield(L, -1, to_luastring("err"));
          msg = lua.lua_tojsstring(L, -1) ?? "ERR unknown script error";
          lua.lua_pop(L, 1);
        } else {
          msg = `ERR user_script:${lua.lua_tojsstring(L, -1) ?? "error"} script: ${sha}`;
        }
        throw new RedisError(msg);
      }
      return this.toReply(L, -1);
    } finally {
      lua.lua_settop(L, base);
      this.caller = prev;
    }
  }
}
