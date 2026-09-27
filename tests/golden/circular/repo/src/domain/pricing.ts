import { applyDiscount } from "./discount";

export function price(base: number): number {
  return applyDiscount(base);
}

export const BASE_RATE = 1;
