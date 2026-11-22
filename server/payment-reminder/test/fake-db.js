"use strict";
// 테스트용 메모리 Firestore (firebase-admin 에서 쓰는 부분만)
function fakeDb(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const writes = [];
  const snap = path => ({ exists: store.has(path), id: path.split("/").pop(), data: () => store.has(path) ? JSON.parse(JSON.stringify(store.get(path))) : undefined });
  const doc = path => ({
    id: path.split("/").pop(), path,
    get: async () => snap(path),
    set: async (data, opts) => { writes.push(["set", path]); store.set(path, opts && opts.merge && store.has(path) ? { ...store.get(path), ...data } : data); },
    create: async data => { if (store.has(path)) { const e = new Error("6 ALREADY_EXISTS: Document already exists"); e.code = 6; throw e; } writes.push(["create", path]); store.set(path, data); },
    update: async data => { writes.push(["update", path]); store.set(path, { ...store.get(path), ...data }); },
  });
  return {
    store, writes,
    doc,
    collection: name => ({
      doc: id => doc(`${name}/${id}`),
      listDocuments: async () => {
        const ids = new Set();
        for (const k of store.keys()) if (k.startsWith(name + "/")) ids.add(k.split("/")[1]);
        return Array.from(ids).map(id => ({ id }));
      },
    }),
    runTransaction: async fn => {
      const ops = [];
      const result = await fn({ get: ref => ref.get(), update: (ref, d) => ops.push(() => ref.update(d)), set: (ref, d, o) => ops.push(() => ref.set(d, o)) });
      for (const op of ops) await op();
      return result;
    },
  };
}
module.exports = { fakeDb };
