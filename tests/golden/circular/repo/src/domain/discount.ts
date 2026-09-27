import { BASE_RATE } from "./pricing";

export function applyDiscount(amount: number): number {
  return amount * BASE_RATE * 0.9;
}
