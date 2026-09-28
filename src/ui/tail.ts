import fs from 'node:fs';

/** Incrementally reads a JSONL file: each read() parses only the complete lines appended since the last one. */
export class JsonlTail<T> {
  items: T[] = [];
  private file = '';
  private offset = 0;
  private rest: Buffer = Buffer.alloc(0);
  private max: number;

  constructor(file = '', max = Infinity) {
    this.file = file;
    this.max = max;
  }

  /** Points the tail at another file (e.g. the next cycle's activity), starting from scratch. */
  setFile(file: string) {
    if (file === this.file) return;
    this.file = file;
    this.reset();
  }

  private reset() {
    this.items = [];
    this.offset = 0;
    this.rest = Buffer.alloc(0);
  }

  /** Returns the items appended since the previous call. */
  read(): T[] {
    if (!this.file) return [];
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      if (this.offset) this.reset();
      return [];
    }
    if (size < this.offset) this.reset(); // truncated or replaced
    if (size === this.offset) return [];
    const buf = Buffer.alloc(size - this.offset);
    const fd = fs.openSync(this.file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset = size;
    const data = Buffer.concat([this.rest, buf]);
    const end = data.lastIndexOf(0x0a);
    if (end < 0) {
      this.rest = data;
      return [];
    }
    this.rest = data.subarray(end + 1);
    const fresh: T[] = [];
    for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        fresh.push(JSON.parse(line) as T);
      } catch {
        // corrupt line
      }
    }
    this.items.push(...fresh);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    return fresh;
  }
}
