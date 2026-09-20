/**
 * playwright serialises a function with toString and evaluates it in the page. two things
 * break that for code written here:
 * - tsx (esbuild keepNames) injects `__name(fn, "fn")` calls into the source, and the page
 *   has no such helper. the wrapper declares one.
 * - vitest's ssr transform rewrites an imported identifier to `__vi_ssr_import_0__.name`,
 *   so an in-page function can never import a helper. instead it declares the helper
 *   ambient (`declare function name(...)`) and passes it here; the helper's source is
 *   declared in the wrapper under its own name, where the function's body finds it.
 *
 * `fn` and every helper must be a function declaration or an arrow: their sources are
 * re-evaluated standalone, and method shorthand (`{ fn() {} }`) does not survive that as
 * an expression. a helper must itself be self-contained or only call helpers listed
 * before it. only sources of functions in this repo are ever interpolated; `arg` is a
 * parameter, never text.
 */
export function inPage<A, R>(
  fn: (arg: A) => R,
  helpers: ((...args: never[]) => unknown)[] = [],
): (arg: A) => R {
  const prelude = helpers.map((h) => h.toString()).join('\n');
  return new Function(
    'arg',
    `const __name = (target) => target;\n${prelude}\nreturn (${fn.toString()})(arg);`,
  ) as (arg: A) => R;
}
