import { getSettings } from "../db";
import type { ModelInfo, ResourceReservation, ResourceSnapshot } from "../types";
import { uid } from "../utils";
import { getHardwareProfile } from "../system/hardware-profiler";

interface AcquireOptions {
  model: ModelInfo;
  fallbackModel?: ModelInfo;
  agentId?: string;
  agentName?: string;
  label: string;
  priority?: number;
  allowConcurrency?: boolean;
  runId?: string;
}

interface Waiter {
  options: AcquireOptions;
  resolve: (reservation: ResourceReservation) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  reservation: ResourceReservation;
  fallbackReason?: string;
}

function makeReservation(options: AcquireOptions, model: ModelInfo, fallbackReason?: string): ResourceReservation {
  return {
    id: uid("res"),
    label: options.label,
    agentId: options.agentId,
    agentName: options.agentName,
    modelKey: model.key,
    modelName: model.name,
    provider: model.provider,
    vramMB: model.kind === "local" ? model.vramEstimateMB : 0,
    heavy: model.heavy,
    priority: options.priority ?? 5,
    enqueuedAt: Date.now(),
    status: "queued",
    fallbackReason,
  };
}

class ResourceQueueManager {
  private running = new Map<string, ResourceReservation>();
  private queue: Waiter[] = [];
  private history: ResourceReservation[] = [];
  private pumpScheduled = false;

  async snapshot(): Promise<ResourceSnapshot> {
    const settings = await getSettings();
    const profile = getHardwareProfile();
    const budgetMB = Math.max(1024, Math.min(settings.vramBudgetMB - settings.reserveMB, profile.localBudgetMB));
    const running = Array.from(this.running.values());
    const usedMB = running.reduce((sum, item) => sum + item.vramMB, 0);
    return {
      budgetMB: settings.vramBudgetMB,
      reserveMB: settings.vramBudgetMB - budgetMB,
      usedMB,
      availableMB: Math.max(0, budgetMB - usedMB),
      running,
      queued: this.queue.map((waiter) => waiter.reservation),
      history: this.history.slice(0, 30),
      heavyRunning: running.filter((item) => item.heavy).length,
      maxConcurrentHeavy: profile.maxConcurrentHeavy,
      allowConcurrentLight: settings.allowConcurrentLight,
      updatedAt: Date.now(),
    };
  }

  private canRun(reservation: ResourceReservation): boolean {
    // Cloud providers do not consume local unified memory.
    if (reservation.provider !== "ollama" && reservation.provider !== "lmstudio") return true;
    const used = Array.from(this.running.values()).reduce((sum, item) => sum + item.vramMB, 0);
    const budget = this.lastBudgetMB ?? getHardwareProfile().localBudgetMB;
    const heavyRunning = Array.from(this.running.values()).filter((item) => item.heavy).length;
    const lightRunning = Array.from(this.running.values()).filter(
      (item) => !item.heavy && (item.provider === "ollama" || item.provider === "lmstudio"),
    ).length;
    // Heavy local generations are serialized for the 48 GB Apple Silicon target.
    const profile = getHardwareProfile();
    const maxHeavy = profile.maxConcurrentHeavy;
    const maxLight = Math.min(this.lastMaxLight ?? profile.maxConcurrentLight, profile.maxConcurrentLight);
    const allowConcurrentLight = this.lastAllowConcurrentLight ?? true;

    if (reservation.heavy && heavyRunning >= maxHeavy) return false;
    if (!reservation.heavy && !allowConcurrentLight && (heavyRunning > 0 || lightRunning > 0)) return false;
    if (!reservation.heavy && lightRunning >= maxLight) return false;
    if (!reservation.heavy && reservation.vramMB + used > budget) return false;
    if (reservation.heavy && reservation.vramMB + used > budget) return false;
    return true;
  }

  private lastBudgetMB?: number;
  private lastMaxLight?: number;
  private lastAllowConcurrentLight?: boolean;

  async refreshPolicy() {
    const settings = await getSettings();
    const profile = getHardwareProfile();
    this.lastBudgetMB = Math.max(1024, Math.min(settings.vramBudgetMB - settings.reserveMB, profile.localBudgetMB));
    this.lastMaxLight = Math.min(settings.maxConcurrentLight, profile.maxConcurrentLight);
    this.lastAllowConcurrentLight = settings.allowConcurrentLight;
  }

  async acquire(options: AcquireOptions): Promise<ResourceReservation> {
    await this.refreshPolicy();
    const fallback = options.fallbackModel;
    const canFallback = fallback && fallback.key !== options.model.key;

    // Cloud models bypass the VRAM queue entirely.
    if (options.model.provider !== "ollama" && options.model.provider !== "lmstudio") {
      const reservation = makeReservation(options, options.model);
      reservation.status = "running";
      reservation.startedAt = Date.now();
      this.running.set(reservation.id, reservation);
      return reservation;
    }

    const profile = getHardwareProfile();
    if (profile.restrictHeavyLocalModels && options.model.heavy) {
      if (canFallback && (!fallback.heavy || (fallback.provider !== "ollama" && fallback.provider !== "lmstudio"))) {
        const reservation = makeReservation(options, fallback, `${profile.label}: routed heavy local model to ${fallback.name}.`);
        this.start(reservation);
        return reservation;
      }
      throw new Error(`${profile.label}: heavy local models are disabled; choose a cloud or lightweight local model.`);
    }

    if (this.canRun(makeReservation(options, options.model))) {
      const reservation = makeReservation(options, options.model);
      this.start(reservation);
      return reservation;
    }

    // If the model can never fit inside the configured budget, fall back immediately
    // rather than making the user wait for an impossible reservation.
    const fitsAtAll = options.model.vramEstimateMB <= (this.lastBudgetMB ?? 28_672);
    if (canFallback && fallback.provider !== "ollama" && fallback.provider !== "lmstudio" && !fitsAtAll) {
      const reservation = makeReservation(
        options,
        fallback,
        `${options.model.name} is over the local VRAM budget; routed to ${fallback.name}.`,
      );
      this.start(reservation);
      return reservation;
    }

    const settings = await getSettings();
    const reservation = makeReservation(options, options.model);
    return new Promise<ResourceReservation>((resolve, reject) => {
      const waiter: Waiter = {
        options,
        resolve,
        reject,
        reservation,
      };
      waiter.timer = setTimeout(async () => {
        this.queue = this.queue.filter((item) => item !== waiter);
        const current = await getSettings();
        if (
          current.allowCloudFallback &&
          fallback &&
          fallback.provider !== "ollama" &&
          fallback.provider !== "lmstudio"
        ) {
          const fallbackReservation = makeReservation(
            options,
            fallback,
            `Timed out after ${Math.round(settings.vramQueueTimeoutMs / 1000)}s waiting for ${options.model.name}; fell back to ${fallback.name}.`,
          );
          this.start(fallbackReservation);
          resolve(fallbackReservation);
        } else {
          reject(
            new Error(
              `Local model queue timed out for ${options.model.name}. Another generation is holding the VRAM budget.`,
            ),
          );
        }
      }, settings.vramQueueTimeoutMs);
      this.queue.push(waiter);
      this.queue.sort((a, b) => (b.reservation.priority ?? 5) - (a.reservation.priority ?? 5));
      this.schedulePump();
    });
  }

  private start(reservation: ResourceReservation) {
    reservation.status = "running";
    reservation.startedAt = Date.now();
    this.running.set(reservation.id, reservation);
  }

  release(reservation: ResourceReservation) {
    this.running.delete(reservation.id);
    const finished = { ...reservation, status: "released" as const };
    this.history.unshift(finished);
    if (this.history.length > 60) this.history.length = 60;
    this.schedulePump();
  }

  private schedulePump() {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setTimeout(() => {
      this.pumpScheduled = false;
      void this.pump();
    }, 40);
  }

  private async pump() {
    await this.refreshPolicy();
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.queue.length; i++) {
        const waiter = this.queue[i];
        if (this.canRun(waiter.reservation)) {
          this.queue.splice(i, 1);
          if (waiter.timer) clearTimeout(waiter.timer);
          this.start(waiter.reservation);
          waiter.resolve(waiter.reservation);
          progressed = true;
          break;
        }
      }
    }
  }

  cancel(reservationId: string) {
    const waiterIndex = this.queue.findIndex((item) => item.reservation.id === reservationId);
    if (waiterIndex >= 0) {
      const [waiter] = this.queue.splice(waiterIndex, 1);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error("Cancelled while queued."));
      return true;
    }
    return false;
  }

  reset() {
    for (const waiter of this.queue) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error("Queue reset."));
    }
    this.queue = [];
    this.running.clear();
  }
}

const globalStore = globalThis as typeof globalThis & {
  __factoryQueue?: ResourceQueueManager;
};

export const resourceQueue = (globalStore.__factoryQueue ??= new ResourceQueueManager());
