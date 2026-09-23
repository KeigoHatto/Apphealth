"""テスト用の最小限なインメモリ Supabase クライアント。"""

from types import SimpleNamespace


class _Query:
    def __init__(self, store, table):
        self.store, self.table = store, table
        self.filters, self.orders = [], []
        self.op, self.payload, self.on_conflict, self.cols = "select", None, None, "*"
        self.rng = None

    # --- builder
    def select(self, cols="*"):
        self.op, self.cols = "select", cols
        return self

    def insert(self, rows):
        self.op, self.payload = "insert", rows
        return self

    def upsert(self, rows, on_conflict=""):
        self.op, self.payload, self.on_conflict = "upsert", rows, on_conflict
        return self

    def update(self, values):
        self.op, self.payload = "update", values
        return self

    def delete(self):
        self.op = "delete"
        return self

    def eq(self, col, v):
        self.filters.append(lambda r: r.get(col) == v)
        return self

    def gte(self, col, v):
        self.filters.append(lambda r: r.get(col) is not None and str(r[col]) >= str(v))
        return self

    def lte(self, col, v):
        self.filters.append(lambda r: r.get(col) is not None and str(r[col]) <= str(v))
        return self

    def order(self, col, desc=False):
        self.orders.append((col, desc))
        return self

    def range(self, a, b):
        self.rng = (a, b)
        return self

    # --- execution
    def _match(self, r):
        return all(f(r) for f in self.filters)

    def execute(self):
        rows = self.store.setdefault(self.table, [])
        if self.table == "metric_catalog":
            rows = self._catalog()
        if self.op == "select":
            out = [dict(r) for r in rows if self._match(r)]
            for col, desc in reversed(self.orders):
                out.sort(key=lambda r: (r.get(col) is None, r.get(col)), reverse=desc)
            if self.rng:
                out = out[self.rng[0]:self.rng[1] + 1]
            if self.cols != "*":
                keep = self.cols.split(",")
                out = [{k: r.get(k) for k in keep} for r in out]
            return SimpleNamespace(data=out)
        if self.op == "insert":
            payload = self.payload if isinstance(self.payload, list) else [self.payload]
            out = []
            for p in payload:
                row = {"id": self.store["_seq"].__next__(), **p}
                rows.append(row)
                out.append(dict(row))
            return SimpleNamespace(data=out)
        if self.op == "upsert":
            keys = self.on_conflict.split(",")
            for p in self.payload:
                existing = next((r for r in rows if all(r.get(k) == p.get(k) for k in keys)), None)
                if existing:
                    existing.update(p)
                else:
                    rows.append({"id": p.get("id", self.store["_seq"].__next__()), **p})
            return SimpleNamespace(data=self.payload)
        if self.op == "update":
            out = []
            for r in rows:
                if self._match(r):
                    r.update(self.payload)
                    out.append(dict(r))
            return SimpleNamespace(data=out)
        if self.op == "delete":
            self.store[self.table] = [r for r in rows if not self._match(r)]
            return SimpleNamespace(data=[])
        raise NotImplementedError(self.op)

    def _catalog(self):
        by = {}
        for r in self.store.get("health_metrics", []):
            c = by.setdefault(r["metric_name"], {"metric_name": r["metric_name"], "units": r.get("units"),
                                                 "n_rows": 0, "first_date": r["date"], "last_date": r["date"]})
            c["n_rows"] += 1
            c["first_date"] = min(c["first_date"], r["date"])
            c["last_date"] = max(c["last_date"], r["date"])
        return list(by.values())


class FakeClient:
    def __init__(self):
        import itertools
        self.store = {"_seq": itertools.count(1)}

    def table(self, name):
        return _Query(self.store, name)
