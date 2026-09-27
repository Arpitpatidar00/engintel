import { HealthRepository } from "../repositories/health.repository";

export function health(): boolean {
  return new HealthRepository().ping();
}
