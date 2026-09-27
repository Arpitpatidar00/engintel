import type { Order } from "../domain/order";
import { OrderRepository } from "../repositories/order.repository";

export class OrderService {
  constructor(private readonly repository = new OrderRepository()) {}

  createOrder(order: Order): Order {
    this.repository.save(order);
    return order;
  }

  getOrder(id: string): Order | undefined {
    return this.repository.find(id);
  }
}
