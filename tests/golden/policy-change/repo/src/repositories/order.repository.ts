import type { Order } from "../domain/order";

const rows = new Map<string, Order>();

export class OrderRepository {
  find(id: string): Order | undefined {
    return rows.get(id);
  }

  save(order: Order): void {
    rows.set(order.id, order);
  }
}
