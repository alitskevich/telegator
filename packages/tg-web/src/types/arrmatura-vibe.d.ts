/**
 * The slice of `arrmatura-vibe` the console calls, typed. Its source imports
 * `arrmatura-web`'s, which fails this repo's stricter `tsc`, so `tsconfig.json`
 * maps it here, as it does `arrmatura-web`; esbuild still bundles the real source.
 */
declare module "arrmatura-vibe" {
  /** `DevTools` and its `VibeService`, for the registry. */
  export const components: readonly unknown[];
}
