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
    const writes: (() => void)[] = [];
    return {
      get: async (ref: Ref | Query) => "path" in ref ? snapshot(ref.path) : querySnapshot(ref),
      create: (ref: Ref, data: Row) => { writes.push(() => {
        if (docs.has(ref.path)) throw new Error("Document already exists");
        write(ref, data);
      }); },
      update: (ref: Ref, data: Row) => { writes.push(() => write(ref, data, true)); },
      commit: () => { writes.forEach((apply) => apply()); },
    };
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
