import type { OrderService } from "../services/order.service";

export type OrderLookup = Pick<OrderService, "getOrder">;

export function cents(amount: number): number {
  return Math.round(amount * 100);
}
