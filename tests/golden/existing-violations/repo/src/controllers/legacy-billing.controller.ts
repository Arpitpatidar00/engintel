import { OrderRepository } from "../repositories/order.repository";

export class LegacyBillingController {
  private readonly repository = new OrderRepository();

  total(id: string): number {
    return this.repository.find(id)?.total ?? 0;
  }
}
