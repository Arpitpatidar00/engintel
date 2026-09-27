import type { OrderRepository } from "../repositories/order.repository";

export function describeRepository(repository: OrderRepository): string {
  return typeof repository;
}
