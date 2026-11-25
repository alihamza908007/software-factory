import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "@/lib/data/db";

/**
 * Durable per-thread chat event log with server-side replay.
 *
 * Mirrors the run-event bus (`src/lib/core/events.ts`): synchronous hydrate on
 * first use, debounced atomic writes, and bounded history. Turn events are
 * published as the turn runs so a client that drops or reloads mid-stream can
 * reattach at `GET /api/threads/[id]/events?since=…` and continue where it
 * left off.
 */

type Listener = (event: ChatEvent, sequence: number) => void;

export interface ChatEvent {
  type: string;
  [key: string]: unknown;
}

interface ThreadChannel {
  events: Array<{ event: ChatEvent; sequence: number }>;
  sequence: number;
  listeners: Set<Listener>;
}

interface PersistedChatEvents {
  version: 1;
  threads: Record<string, { sequence: number; events: Array<{ event: ChatEvent; sequence: number }> }>;
  updatedAt: number;
}

const CHAT_EVENTS_PATH = path.join(DATA_ROOT, "chat-events.json");
const PERSIST_DEBOUNCE_MS = 350;
const MAX_THREADS_ON_DISK = 24;
const MAX_EVENTS_PER_THREAD = 400;
const MAX_EVENTS_IN_MEMORY = 800;

const globalStore = globalThis as typeof globalThis & { __factoryChatEventsBus?: ChatEventBus };

class ChatEventBus {
  private channels = new Map<string, ThreadChannel>();
  private limit = MAX_EVENTS_IN_MEMORY;
  private persistedThreads = new Set<string>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private writeChain: Promise<void> | null = null;

  private ensureHydrated(): void {
    if (this.persistedThreads.size || this.channels.size) return;
    let parsed: PersistedChatEvents;
    try {
      parsed = JSON.parse(fs.readFileSync(CHAT_EVENTS_PATH, "utf8")) as PersistedChatEvents;
    } catch {
      return;
    }
    if (parsed?.version !== 1 || !parsed.threads) return;
    for (const [threadId, channel] of Object.entries(parsed.threads)) {
      if (this.channels.has(threadId)) continue;
      const events = (channel.events ?? []).filter(
        (item) => item?.event && typeof item.event.type === "string",
      );
      this.channels.set(threadId, {
        events,
        sequence: Math.max(
          channel.sequence ?? 0,
          events.reduce((max, item) => Math.max(max, item.sequence), 0),
        ),
        listeners: new Set(),
      });
      this.persistedThreads.add(threadId);
    }
  }

  private snapshotForDisk(): PersistedChatEvents {
    const recent = Array.from(this.channels.entries())
      .map(([threadId, channel]) => ({
        threadId,
        at: channel.events.reduce((max, item) => Math.max(max, item.sequence), 0),
        channel,
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_THREADS_ON_DISK);
    const threads: PersistedChatEvents["threads"] = {};
    for (const { threadId, channel } of recent) {
      threads[threadId] = {
        sequence: channel.sequence,
        events: channel.events.slice(-MAX_EVENTS_PER_THREAD),
      };
    }
    return { version: 1, threads, updatedAt: Date.now() };
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const snapshot = this.snapshotForDisk();
      this.writeChain = (this.writeChain ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          await fs.promises.mkdir(DATA_ROOT, { recursive: true });
          const tmp = `${CHAT_EVENTS_PATH}.${process.pid}.tmp`;
          await fs.promises.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
          await fs.promises.rename(tmp, CHAT_EVENTS_PATH);
        })
        .catch(() => undefined);
    }, PERSIST_DEBOUNCE_MS);
    (this.persistTimer as unknown as { unref?: () => void }).unref?.();
  }

  private channel(threadId: string): ThreadChannel {
    this.ensureHydrated();
    let channel = this.channels.get(threadId);
    if (!channel) {
      channel = { events: [], sequence: 0, listeners: new Set() };
      this.channels.set(threadId, channel);
    }
    return channel;
  }

  publish(threadId: string, event: ChatEvent): void {
    const channel = this.channel(threadId);
    const sequenced = { event, sequence: ++channel.sequence };
    channel.events.push(sequenced);
    if (channel.events.length > this.limit) {
      channel.events.splice(0, channel.events.length - this.limit);
    }
    for (const listener of channel.listeners) {
      try {
        listener(event, sequenced.sequence);
      } catch {
        // a broken SSE consumer must not break the chat turn
      }
    }
    this.schedulePersist();
  }

  subscribe(threadId: string, listener: Listener): () => void {
    const channel = this.channel(threadId);
    channel.listeners.add(listener);
    return () => {
      channel.listeners.delete(listener);
    };
  }

  backlog(threadId: string): Array<{ event: ChatEvent; sequence: number }> {
    return this.channel(threadId).events.slice();
  }

  since(threadId: string, sequence: number): Array<{ event: ChatEvent; sequence: number }> {
    return this.channel(threadId).events.filter((item) => item.sequence > sequence);
  }

  sequenceNumber(threadId: string): number {
    return this.channel(threadId).sequence;
  }

  clear(threadId: string): void {
    this.ensureHydrated();
    this.channels.delete(threadId);
    this.schedulePersist();
  }
}

export const chatEvents = (globalStore.__factoryChatEventsBus ??= new ChatEventBus());
