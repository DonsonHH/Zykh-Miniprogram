function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function missingDocumentError(id) {
  const error = new Error(`document ${id} does not exist`);
  error.code = "DATABASE_DOCUMENT_NOT_EXIST";
  return error;
}

function createInMemoryCloudDb(seed = {}) {
  const collections = new Map();
  let sequence = 0;

  Object.keys(seed).forEach(name => {
    const rows = Array.isArray(seed[name]) ? seed[name] : [];
    collections.set(name, new Map(rows.map((row, index) => {
      const id = String(row._id || `${name}-${index + 1}`);
      return [id, Object.assign({ _id: id }, clone(row))];
    })));
  });

  function bucket(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  function document(name, id) {
    const normalizedId = String(id);
    return {
      async get() {
        const row = bucket(name).get(normalizedId);
        if (!row) throw missingDocumentError(normalizedId);
        return { data: clone(row) };
      },
      async set({ data }) {
        bucket(name).set(normalizedId, Object.assign({ _id: normalizedId }, clone(data)));
        return { errCode: 0 };
      },
      async update({ data }) {
        const current = bucket(name).get(normalizedId);
        if (!current) throw missingDocumentError(normalizedId);
        bucket(name).set(normalizedId, Object.assign({}, current, clone(data), { _id: normalizedId }));
        return { errCode: 0 };
      },
      async remove() {
        bucket(name).delete(normalizedId);
        return { errCode: 0 };
      },
    };
  }

  function query(name, options = {}) {
    const filters = options.filters || [];
    const skipCount = options.skipCount || 0;
    const limitCount = options.limitCount === undefined ? Infinity : options.limitCount;
    const order = options.order || null;
    return {
      where(filter = {}) {
        return query(name, { filters: filters.concat(filter), skipCount, limitCount, order });
      },
      orderBy(field, direction = "asc") {
        return query(name, {
          filters,
          skipCount,
          limitCount,
          order: { field, direction: String(direction).toLowerCase() },
        });
      },
      skip(value) {
        return query(name, { filters, skipCount: Number(value) || 0, limitCount, order });
      },
      limit(value) {
        return query(name, { filters, skipCount, limitCount: Number(value) || 0, order });
      },
      async get() {
        let rows = Array.from(bucket(name).values()).filter(row => filters.every(filter => (
          Object.keys(filter).every(key => row[key] === filter[key])
        )));
        if (order) {
          rows = rows.slice().sort((left, right) => {
            if (left[order.field] === right[order.field]) return 0;
            const result = left[order.field] < right[order.field] ? -1 : 1;
            return order.direction === "desc" ? -result : result;
          });
        }
        return { data: clone(rows.slice(skipCount, skipCount + limitCount)) };
      },
      async add({ data }) {
        sequence += 1;
        const id = `${name}-generated-${sequence}`;
        bucket(name).set(id, Object.assign({ _id: id }, clone(data)));
        return { _id: id, errCode: 0 };
      },
      doc(id) {
        return document(name, id);
      },
    };
  }

  const db = {
    collection(name) {
      return query(name);
    },
    async runTransaction(callback) {
      const before = new Map(Array.from(collections, ([name, rows]) => [
        name,
        new Map(Array.from(rows, ([id, row]) => [id, clone(row)])),
      ]));
      try {
        return await callback(db);
      } catch (error) {
        collections.clear();
        before.forEach((rows, name) => collections.set(name, rows));
        throw error;
      }
    },
  };

  return {
    db,
    rows(name) {
      return clone(Array.from(bucket(name).values()));
    },
    row(name, id) {
      return clone(bucket(name).get(String(id)) || null);
    },
  };
}

module.exports = { createInMemoryCloudDb };
