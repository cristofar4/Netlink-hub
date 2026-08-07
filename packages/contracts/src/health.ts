export type ComponentHealth = {
  status: 'up' | 'down' | 'degraded';
  detail?: string;
  latencyMs?: number;
};

export type HealthResponse = {
  status: 'ok' | 'degraded' | 'error';
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  components: Record<string, ComponentHealth>;
};
