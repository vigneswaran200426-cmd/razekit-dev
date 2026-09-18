export class DurableStateAdapter {
  async health() {
    throw new Error("DurableStateAdapter.health() is not implemented");
  }

  async query() {
    throw new Error("DurableStateAdapter.query() is not implemented");
  }

  async transaction() {
    throw new Error("DurableStateAdapter.transaction() is not implemented");
  }
}

export class PostgresStateAdapter extends DurableStateAdapter {
  constructor({ pool } = {}) {
    super();
    if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
      throw new Error("Postgres pool with query() and connect() is required");
    }
    this.pool = pool;
  }

  async health() {
    const result = await this.pool.query("SELECT 1 AS ok");
    return result.rows?.[0]?.ok === 1;
  }

  async query(text, params = []) {
    return this.pool.query(text, params);
  }

  async transaction(handler) {
    if (typeof handler !== "function") throw new Error("Transaction handler is required");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await handler(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class DurableStateRegistry {
  constructor() {
    this.adapter = null;
  }

  configure(adapter) {
    if (!adapter || typeof adapter.health !== "function" || typeof adapter.query !== "function" || typeof adapter.transaction !== "function") {
      throw new Error("Durable state adapter is invalid");
    }
    this.adapter = adapter;
  }

  get() {
    if (!this.adapter) throw new Error("Durable state adapter is not configured");
    return this.adapter;
  }
}
