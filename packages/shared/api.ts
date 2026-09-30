import type { Cart } from "./cart";
import type { Verdict } from "./verdict";

export interface DecideRequest {
  cart: Cart;
}

export type DecideResponse = Verdict;

export interface ApiError {
  code: string;
  message: string;
}
