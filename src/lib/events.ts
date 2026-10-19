import type { RunEvent } from "./types";

type Listener = (event: RunEvent) => void;

type RunChannel = {
  events: RunEvent[];
  listeners: Set<Listener>;
};

class RunEventBus {
  private channels = new Map<string, RunChannel>();
  private limit = 600;

  private channel(runId: string): RunChannel {
    let channel = this.channels.get(runId);
    if (!channel) {
      channel = { events: [], listeners: new Set() };
      this.channels.set(runId, channel);
    }
    return channel;
  }

  publish(runId: string, event: RunEvent) {
    const channel = this.channel(runId);
    channel.events.push(event);
    if (channel.events.length > this.limit) {
      channel.events.splice(0, channel.events.length - this.limit);
    }
    for (const listener of channel.listeners) {
      try {
        listener(event);
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

  backlog(runId: string): RunEvent[] {
    return this.channel(runId).events.slice();
  }

  clear(runId: string) {
    this.channels.delete(runId);
  }
}

const globalStore = globalThis as typeof globalThis & {
  __factoryEventBus?: RunEventBus;
};

export const runEvents = (globalStore.__factoryEventBus ??= new RunEventBus());
