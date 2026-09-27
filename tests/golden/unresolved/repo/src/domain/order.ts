export interface Order {
  id: string;
  total: number;
}

export function orderTotal(order: Order): number {
  return order.total;
}
