/**
 * MemoryCache — A pure in-process cache with TTL, LRU eviction, and stats.
 * Replaces Redis for a single-process Node server.
 */
class MemoryCache {
  constructor({ maxSize = 500, defaultTTL = 60 * 5 } = {}) {
    this.store = new Map();   // key → { value, expiresAt, hits }
    this.maxSize = maxSize;   // max number of entries
    this.defaultTTL = defaultTTL; // seconds
    this.stats = { hits: 0, misses: 0, sets: 0, evictions: 0, expirations: 0 };

    // Sweep expired entries every 30 seconds
    this._sweepInterval = setInterval(() => this._sweep(), 30_000);
    this._sweepInterval.unref?.(); // don't keep process alive
  }

  /** Store a value. ttl in seconds (0 = never expire). */
  set(key, value, ttl = this.defaultTTL) {
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      this._evictLRU();
    }
    const expiresAt = ttl > 0 ? Date.now() + ttl * 1000 : Infinity;
    this.store.set(key, { value, expiresAt, hits: 0, lastAccessed: Date.now() });
    this.stats.sets++;
    return true;
  }

  /** Retrieve a value. Returns undefined on miss or expiry. */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) { this.stats.misses++; return undefined; }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.stats.misses++;
      this.stats.expirations++;
      return undefined;
    }
    entry.hits++;
    entry.lastAccessed = Date.now();
    this.stats.hits++;
    return entry.value;
  }

  /** Check existence without updating hit count. */
  has(key) {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) { this.store.delete(key); return false; }
    return true;
  }

  /** Delete a key. */
  del(key) {
    return this.store.delete(key);
  }

  /** Delete all keys matching a prefix. */
  delByPrefix(prefix) {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) { this.store.delete(key); count++; }
    }
    return count;
  }

  /** Get or compute: if key exists return cached, else call fn, cache and return result. */
  async getOrSet(key, fn, ttl = this.defaultTTL) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await fn();
    if (value !== undefined && value !== null) this.set(key, value, ttl);
    return value;
  }

  /** Current number of live entries (approximate — doesn't sweep first). */
  get size() { return this.store.size; }

  /** Snapshot of hit-rate stats. */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      size: this.store.size,
      hitRate: total ? ((this.stats.hits / total) * 100).toFixed(1) + '%' : 'N/A',
    };
  }

  /** Remove the least-recently-used entry. */
  _evictLRU() {
    let oldestKey = null, oldestTime = Infinity;
    for (const [key, entry] of this.store) {
      if (entry.lastAccessed < oldestTime) { oldestTime = entry.lastAccessed; oldestKey = key; }
    }
    if (oldestKey) { this.store.delete(oldestKey); this.stats.evictions++; }
  }

  /** Remove expired entries. */
  _sweep() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) { this.store.delete(key); this.stats.expirations++; }
    }
  }

  /** Flush everything. */
  flush() { this.store.clear(); }

  destroy() { clearInterval(this._sweepInterval); this.flush(); }
}

// ── Named cache buckets ─────────────────────────────────────────────────────
const messageCache   = new MemoryCache({ maxSize: 1000, defaultTTL: 300 });  // 5 min
const roomCache      = new MemoryCache({ maxSize: 200,  defaultTTL: 600 });  // 10 min
const userCache      = new MemoryCache({ maxSize: 500,  defaultTTL: 120 });  // 2 min
const presenceCache  = new MemoryCache({ maxSize: 500,  defaultTTL: 0   });  // no expiry (manual)

module.exports = { MemoryCache, messageCache, roomCache, userCache, presenceCache };
