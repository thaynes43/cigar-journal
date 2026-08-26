// The one piece of "domain" state the spike carries: a single test value plus
// a monotonic read counter. Persisted to a JSON file so a pod restart is
// visible to whoever is poking the server from a real client.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.js";

interface Persisted {
  value: string;
  setBy: string;
  setAt: string;
  readCount: number;
}

const INITIAL: Persisted = {
  value: "(unset)",
  setBy: "system",
  setAt: new Date(0).toISOString(),
  readCount: 0,
};

export class TestValueStore {
  private state: Persisted;

  constructor(private readonly file: string) {
    this.state = this.load();
  }

  private load(): Persisted {
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      return { ...INITIAL, ...parsed };
    } catch {
      return { ...INITIAL };
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch (err) {
      log("store", "failed to persist state", { file: this.file, error: String(err) });
    }
  }

  /** Reads the value and bumps the monotonic call counter. */
  read(): { value: string; setBy: string; setAt: string; readCount: number } {
    this.state.readCount += 1;
    this.save();
    return { ...this.state };
  }

  /** Stores a new value, returns previous + new. */
  write(value: string, setBy: string): { previous: string; current: string } {
    const previous = this.state.value;
    this.state.value = value;
    this.state.setBy = setBy;
    this.state.setAt = new Date().toISOString();
    this.save();
    return { previous, current: value };
  }
}
