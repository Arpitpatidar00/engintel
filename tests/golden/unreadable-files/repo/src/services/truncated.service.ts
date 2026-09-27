import type { Order } from "../domain/order";

export function summarize(order: Order): string {
  return `order ${order.id} totals ${order.total
