import { MetricsRepository } from "../repositories/metrics.repository";

export function metrics(): number {
  return new MetricsRepository().count();
}
