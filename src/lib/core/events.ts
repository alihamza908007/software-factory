import type { RunEvent } from "@/lib/core/types";

type Listener = (event: RunEvent, sequence: number) => void;

type RunChannel = {
  events: Array<{ event: RunEvent; sequence: number }>;
  listeners: Set<Listener>;
  sequence: number;
};

class RunEventBus {
  private channels = new Map<string, RunChannel>();
  private limit = 600;

  private channel(runId: string): RunChannel {
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
    this.channels.delete(runId);
  }
}

const globalStore = globalThis as typeof globalThis & {
  __factoryEventBus?: RunEventBus;
};

export const runEvents = (globalStore.__factoryEventBus ??= new RunEventBus());
