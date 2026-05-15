import * as fs from "node:fs";
import * as path from "node:path";
import type { Event, RuntimeState } from "./types.js";

export class StateStore {
  constructor(private readonly workingDir: string) {}

  initialState(initial: RuntimeState): void {
    fs.mkdirSync(this.workingDir, { recursive: true });
    fs.mkdirSync(path.join(this.workingDir, "nodes"), { recursive: true });
    fs.mkdirSync(path.join(this.workingDir, "artifacts"), { recursive: true });
    fs.writeFileSync(this.statePath(), JSON.stringify(initial, null, 2));
    fs.writeFileSync(this.eventLogPath(), "");   // create empty file
  }

  readState(): RuntimeState {
    return JSON.parse(fs.readFileSync(this.statePath(), "utf8")) as RuntimeState;
  }

  writeState(s: RuntimeState): void {
    // Atomic write: tmp + rename
    const tmp = `${this.statePath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, this.statePath());
  }

  appendEvents(events: Event[]): void {
    const lines = events.map(e => JSON.stringify(e)).join("\n") + "\n";
    fs.appendFileSync(this.eventLogPath(), lines);
  }

  writeArtifact(relPath: string, content: string): void {
    const abs = path.join(this.workingDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  writeNodeArchive(nodeExecId: string, files: Record<string, string>): void {
    const dir = path.join(this.workingDir, "nodes", nodeExecId);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
  }

  private statePath():    string { return path.join(this.workingDir, "state.json"); }
  private eventLogPath(): string { return path.join(this.workingDir, "events.log.jsonl"); }
}
