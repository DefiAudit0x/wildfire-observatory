// Storage-only Firestore double. Authorization, badge trust, cache TTLs and
// invalidation remain in the production modules that consume this adapter.
type Row = Record<string, unknown>;
type Ref = { path: string; id: string };
type Query = { collectionName: string; field?: string; value?: unknown; count?: number };

export function memoryAdminDb(docs: Map<string, Row>) {
  const snapshot = (path: string) => {
    const value = docs.get(path);
    return { id: path.split("/").at(-1)!, exists: value !== undefined, data: () => value && structuredClone(value) };
  };
  const querySnapshot = (query: Query) => {
    const rows = [...docs.entries()]
      .filter(([path, data]) => path.startsWith(`${query.collectionName}/`) &&
        (query.field === undefined || data[query.field] === query.value))
      .slice(0, query.count ?? Infinity)
      .map(([path]) => snapshot(path));
    return { docs: rows, size: rows.length, empty: rows.length === 0 };
  };
  const write = (ref: Ref, data: Row, merge = false) => {
    docs.set(ref.path, structuredClone(merge ? { ...docs.get(ref.path), ...data } : data));
  };
  const collection = (name: string, field?: string, value?: unknown, count?: number) => ({
    collectionName: name, field, value, count,
    doc: (id: string) => {
      const ref = { path: `${name}/${id}`, id };
      return { ...ref,
        get: async () => snapshot(ref.path),
        set: async (data: Row) => write(ref, data),
        update: async (data: Row) => write(ref, data, true),
        delete: async () => { docs.delete(ref.path); },
      };
    },
    where: (nextField: string, operator: string, nextValue: unknown) => {
      if (operator !== "==") throw new Error(`Unsupported test query: ${operator}`);
      return collection(name, nextField, nextValue, count);
    },
    limit: (nextCount: number) => collection(name, field, value, nextCount),
    orderBy: () => collection(name, field, value, count),
    get: async () => querySnapshot({ collectionName: name, field, value, count }),
  });
  const transaction = () => {
    // CodeRabbit (PR #215): commit used to apply each queued write
    // directly to the shared `docs` map, so a later write throwing left
    // the earlier writes applied — real Firestore transactions never
    // partially apply. Writes now land in staged storage (reads inside the
    // transaction consult it, so a create-then-get sees its own write) and
    // are published to the shared map only after every write succeeds.
    const staged = new Map<string, Row>();
    const stagedGet = (path: string) => staged.has(path) ? staged.get(path)! : docs.get(path);
    const writes: (() => void)[] = [];
    return {
      get: async (ref: Ref | Query) => "path" in ref
        ? { id: ref.path.split("/").at(-1)!, exists: stagedGet(ref.path) !== undefined, data: () => stagedGet(ref.path) && structuredClone(stagedGet(ref.path)!) }
        : querySnapshot(ref),
      create: (ref: Ref, data: Row) => { writes.push(() => {
        if (stagedGet(ref.path) !== undefined) throw new Error("Document already exists");
        staged.set(ref.path, structuredClone(data));
      }); },
      update: (ref: Ref, data: Row) => { writes.push(() => writeStaged(ref, data)); },
      commit: () => {
        writes.forEach((apply) => apply());
        for (const [path, row] of staged) docs.set(path, row);
      },
    };
    function writeStaged(ref: Ref, data: Row) {
      staged.set(ref.path, structuredClone({ ...stagedGet(ref.path), ...data }));
    }
  };
  let queue = Promise.resolve();
  return { collection, runTransaction: async <T>(callback: (tx: ReturnType<typeof transaction>) => Promise<T>) => {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const tx = transaction();
      const result = await callback(tx);
      tx.commit();
      return result;
    } finally { release(); }
  } };
}
