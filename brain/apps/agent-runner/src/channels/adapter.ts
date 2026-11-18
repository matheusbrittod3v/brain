export interface InboundMessage {
  id: string;
  channelType: string;
  instance?: string;
  senderId: string;
  threadId: string | null;
  text: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  channelType: string;
  instance?: string;
  recipientId: string;
  threadId: string | null;
  text: string;
}

export interface ChannelAdapter {
  readonly channelType: string;
  readonly instance: string;
  start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Pluggable channel registry adapted from NanoClaw's channel-registry.
 * Allows connecting Web, CLI, Webhook, Telegram, Discord, etc. to the same Runner queue.
 */
export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): this {
    this.adapters.set(adapter.instance || adapter.channelType, adapter);
    return this;
  }

  getExact(instanceKey: string): ChannelAdapter | undefined {
    return this.adapters.get(instanceKey);
  }

  getByType(channelType: string): ChannelAdapter | undefined {
    const exact = this.adapters.get(channelType);
    if (exact) return exact;
    for (const adapter of this.adapters.values()) {
      if (adapter.channelType === channelType) return adapter;
    }
    return undefined;
  }

  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  async startAll(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start(onInbound);
    }
  }

  async stopAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }
}

/**
 * Autonomous Heartbeat scheduler (NanoClaw pattern): periodically wakes an agent
 * handler to inspect pending proposals, alerts, or scheduled tasks.
 */
export class HeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly intervalMs: number,
    private readonly onTick: () => Promise<void>
  ) { }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.triggerNow();
    }, this.intervalMs);
  }

  async triggerNow(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.onTick();
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

