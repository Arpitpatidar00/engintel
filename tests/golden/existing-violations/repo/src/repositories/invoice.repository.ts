import { OrderService } from "../services/order.service";

export class InvoiceRepository {
  private readonly orders = new OrderService();

  invoiceFor(id: string) {
    return this.orders.getOrder(id);
  }
}
