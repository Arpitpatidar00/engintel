import type { Order } from "../domain/order";
import { OrderService } from "../services/order.service";

export class OrderController {
  constructor(private readonly service = new OrderService()) {}

  create(body: Order): Order {
    return this.service.createOrder(body);
  }
}
