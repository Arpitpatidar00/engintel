import { OrderRepository } from "../repositories/order.repository";

export class RefundController {
  private readonly repository = new OrderRepository();

  refund(id: string): boolean {
    return this.repository.find(id) !== undefined;
  }
}
