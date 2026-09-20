/**
 * how the source's records are matched to ours. the source names an element by the ref it
 * computed from its own stable path; a rebuild that carries `data-ref` says which source
 * element a node stands for even after its markup moved, so that always wins. the two are
 * one namespace: a `data-ref` holds the source's ref.
 */
export interface Reffed {
  ref: string | null;
  dataRef: string | null;
}

/**
 * ours keyed by the ref the source will look it up under: its `data-ref` when it has one,
 * its own computed ref otherwise. a `data-ref` always claims its key; a computed ref is
 * claimed by the first record that carries it, so a duplicate path never displaces the
 * element the source meant.
 */
export function indexByRef<T extends Reffed>(ours: Iterable<T>): Map<string, T> {
  const byRef = new Map<string, T>();
  for (const el of ours) {
    if (el.dataRef) byRef.set(el.dataRef, el);
    else if (el.ref && !byRef.has(el.ref)) byRef.set(el.ref, el);
  }
  return byRef;
}

/** the key `indexByRef` files one record under. */
export function refOf(el: Reffed): string | null {
  return el.dataRef ?? el.ref;
}
