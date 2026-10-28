import { GameError } from "./errors.js";
import { HostProcess } from "./host-process.js";
import type { SandboxOptions } from "./sandbox.js";

interface Spare {
  host: HostProcess;
  ready: Promise<HostProcess>;
}

/** Only unused processes are pooled. An assigned process is never returned here. */
export class HostPool {
  private readonly spares: Spare[] = [];
  private readonly inFlight = new Set<Spare>();
  private closed = false;

  constructor(
    private readonly options: Required<SandboxOptions>,
    private readonly capacity: number,
  ) {
    this.fill();
  }

  private prepare(): Spare {
    const host = new HostProcess(this.options);
    const ready = host
      .call({ op: "prepare" })
      .then(() => host)
      .catch(() => {
        host.dispose();
        throw new GameError();
      });
    // A spare may fail before a caller acquires it. Its error is handled on take.
    void ready.catch(() => {});
    return { host, ready };
  }

  private fill(): void {
    while (!this.closed && this.spares.length < this.capacity) this.spares.push(this.prepare());
  }

  async take(): Promise<HostProcess> {
    if (this.closed) throw new GameError();
    const candidate = this.spares.shift();
    const spare = candidate?.host.alive ? candidate : this.prepare();
    if (candidate && candidate !== spare) candidate.host.dispose();
    this.fill();
    this.inFlight.add(spare);
    try {
      const host = await spare.ready;
      if (this.closed || !host.alive) throw new GameError();
      return host;
    } catch {
      spare.host.dispose();
      throw new GameError();
    } finally {
      this.inFlight.delete(spare);
    }
  }

  /** Server-only resource measurements and supervision. Includes starting spares. */
  processIds(): number[] {
    return this.spares.flatMap(({ host }) => (host.alive && host.pid ? [host.pid] : []));
  }

  close(): void {
    this.closed = true;
    for (const spare of this.spares) spare.host.dispose();
    for (const spare of this.inFlight) spare.host.dispose();
    this.spares.length = 0;
    this.inFlight.clear();
  }
}
