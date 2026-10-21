declare module "fengari" {
  // Minimal typing: fengari ships no TypeScript declarations.
  export const lua: any;
  export const lauxlib: any;
  export const lualib: any;
  export function to_luastring(s: string): Uint8Array;
  export function to_jsstring(b: Uint8Array): string;
}
