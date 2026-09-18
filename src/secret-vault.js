export class SecretVaultAdapter {
  async put() {
    throw new Error("SecretVaultAdapter.put() is not implemented");
  }

  async get() {
    throw new Error("SecretVaultAdapter.get() is not implemented");
  }

  async revoke() {
    throw new Error("SecretVaultAdapter.revoke() is not implemented");
  }
}

export class ReferenceOnlySecretVault extends SecretVaultAdapter {
  async put() {
    throw new Error("ReferenceOnlySecretVault cannot accept raw secrets");
  }

  async get() {
    return null;
  }

  async revoke() {
    return { revoked: true };
  }
}

export class InMemorySecretVault extends SecretVaultAdapter {
  constructor() {
    super();
    this.secrets = new Map();
  }

  async put(secretRef, secret) {
    if (!secretRef?.trim()) throw new Error("secretRef is required");
    if (typeof secret !== "string" || !secret) throw new Error("secret must be a non-empty string");
    this.secrets.set(secretRef, secret);
    return { secretRef };
  }

  async get(secretRef) {
    return this.secrets.get(secretRef) || null;
  }

  async revoke(secretRef) {
    this.secrets.delete(secretRef);
    return { secretRef, revoked: true };
  }
}

export class SecretVaultRegistry {
  constructor() {
    this.adapter = null;
  }

  configure(adapter) {
    if (!adapter || typeof adapter.put !== "function" || typeof adapter.get !== "function" || typeof adapter.revoke !== "function") {
      throw new Error("Secret vault adapter is invalid");
    }
    this.adapter = adapter;
  }

  get() {
    if (!this.adapter) throw new Error("Secret vault adapter is not configured");
    return this.adapter;
  }
}
