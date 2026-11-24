import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "@/lib/data/db";
import type { RunEvent } from "@/lib/core/types";

type Listener = (event: RunEvent, sequence: number) => void;

type RunChannel = {
  events: Array<{ event: RunEvent; sequence: number }>;
  listeners: Set<Listener>;
  sequence: number;
};

type PersistedRunEvents = {
  version: 1;
  channels: Record<string, { sequence: number; events: Array<{ event: RunEvent; sequence: number }> }>;
  updatedAt: number;
};

const EVENT_LOG_PATH = path.join(DATA_ROOT, "run-events.json");
const PERSIST_DEBOUNCE_MS = 350;
/** Keep the log small: the newest snapshot plus recent incremental events. */
const MAX_RUNS_ON_DISK = 24;
const MAX_EVENTS_ON_DISK = 200;

function eventTime(event: RunEvent): number {
  switch (event.type) {
    case "snapshot":
      return event.run.updatedAt;
    case "log":
      return event.log.at;
    case "heal":
      return event.attempt.createdAt;
    default:
      return 0;
  }
}

class RunEventBus {
  private channels = new Map<string, RunChannel>();
  private limit = 600;
  private hydrated = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private writeChain: Promise<void> | null = null;

  /**
   * Hydrate synchronously on first use. The log is small and bounded, and a
   * synchronous read keeps replay deterministic: a run resumed right after a
   * restart cannot publish events before its saved sequence is restored.
   */
  private ensureHydrated() {
    if (this.hydrated) return;
    this.hydrated = true;
    let parsed: PersistedRunEvents;
    try {
      parsed = JSON.parse(fs.readFileSync(EVENT_LOG_PATH, "utf8")) as PersistedRunEvents;
    } catch {
      return;
    }
    if (parsed?.version !== 1 || !parsed.channels) return;
    for (const [runId, channel] of Object.entries(parsed.channels)) {
      const live = this.channels.get(runId);
      // Never let a stale disk copy overwrite events published in this process.
      if (live && live.events.length) continue;
      const events = (channel.events ?? [])
        .filter((item) => item?.event && Number.isFinite(item.sequence))
        .slice(-this.limit);
      const sequence = Math.max(
        channel.sequence ?? 0,
        events.reduce((max, item) => Math.max(max, item.sequence), 0),
      );
      this.channels.set(runId, { events, listeners: new Set(), sequence });
    }
  }

  private schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const snapshot = this.snapshotForDisk();
      this.writeChain = (this.writeChain ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          await fs.promises.mkdir(DATA_ROOT, { recursive: true });
          const tmp = `${EVENT_LOG_PATH}.${process.pid}.tmp`;
          await fs.promises.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
          await fs.promises.rename(tmp, EVENT_LOG_PATH);
        })
        .catch(() => undefined);
    }, PERSIST_DEBOUNCE_MS);
    (this.persistTimer as unknown as { unref?: () => void }).unref?.();
  }

  private snapshotForDisk(): PersistedRunEvents {
    const recent = Array.from(this.channels.entries())
      .map(([runId, channel]) => ({
        runId,
        channel,
        at: channel.events.reduce((max, item) => Math.max(max, eventTime(item.event)), 0),
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_RUNS_ON_DISK);

    const channels: PersistedRunEvents["channels"] = {};
    for (const { runId, channel } of recent) {
      const latestSnapshot = [...channel.events]
        .reverse()
        .find((item) => item.event.type === "snapshot");
      const incremental = channel.events
        .filter((item) => item.event.type !== "snapshot")
        .slice(-MAX_EVENTS_ON_DISK);
      const events = [...incremental, ...(latestSnapshot ? [latestSnapshot] : [])].sort(
        (a, b) => a.sequence - b.sequence,
      );
      channels[runId] = { sequence: channel.sequence, events };
    }
    return { version: 1, channels, updatedAt: Date.now() };
  }

  private channel(runId: string): RunChannel {
    this.ensureHydrated();
    let channel = this.channels.get(runId);
    if (!channel) {
      channel = { events: [], listeners: new Set(), sequence: 0 };
      this.channels.set(runId, channel);
    }
    return channel;
  }

  publish(runId: string, event: RunEvent) {
    const channel = this.channel(runId);
    const sequenced = { event, sequence: ++channel.sequence };
    channel.events.push(sequenced);
    if (channel.events.length > this.limit) {
      channel.events.splice(0, channel.events.length - this.limit);
    }
    for (const listener of channel.listeners) {
      try {
        listener(event, sequenced.sequence);
      } catch {
        // a broken SSE consumer must not break the pipeline
      }
    }
    this.schedulePersist();
  }

  subscribe(runId: string, listener: Listener): () => void {
    const channel = this.channel(runId);
    channel.listeners.add(listener);
    return () => {
      channel.listeners.delete(listener);
    };
  }

  backlog(runId: string): Array<{ event: RunEvent; sequence: number }> {
    return this.channel(runId).events.slice();
  }

  /** Ordered events the client has not acknowledged, for SSE reconnect replay. */
  since(runId: string, sequence: number, limit = 200): Array<{ event: RunEvent; sequence: number }> {
    return this.channel(runId).events.filter((item) => item.sequence > sequence).slice(-limit);
  }

  sequenceNumber(runId: string): number {
    return this.channel(runId).sequence;
  }

  clear(runId: string) {
    this.ensureHydrated();
    this.channels.delete(runId);
    this.schedulePersist();
  }
}

const globalStore = globalThis as typeof globalThis & {
  __factoryEventBus?: RunEventBus;
};

export const runEvents = (globalStore.__factoryEventBus ??= new RunEventBus());
