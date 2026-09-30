export interface CartItem {
  name: string;
  price: number;
  qty: number;
}

export interface Cart {
  merchant: string;
  items: CartItem[];
  total: number;
  currency: string;
  url: string;
  cart_hash: string;
}
