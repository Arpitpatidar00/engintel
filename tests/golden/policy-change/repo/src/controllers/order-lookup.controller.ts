import { OrderRepository } from "../repositories/order.repository";

export function lookup(id: string) {
  return new OrderRepository().find(id);
}
