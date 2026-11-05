// Keep only recent, bounded search pages in this browser session.
export class PeopleSearchCache<T> {
  private entries = new Map<string, { expiresAt: number; value: T }>();
  private generation = 0;

  get revision() { return this.generation; }

  constructor(private ttlMs = 60_000, private maxEntries = 20) {}

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= now) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, now = Date.now()) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  clear() {
    this.entries.clear();
    this.generation++;
  }
}
