import { OrderRepository } from "../repositories/order.repository";

export class ReportController {
  private readonly repository = new OrderRepository();

  show(id: string) {
    return this.repository.find(id);
  }
}
