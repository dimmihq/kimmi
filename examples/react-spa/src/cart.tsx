import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Product } from './products';

export interface CartLine {
  product: Product;
  quantity: number;
}

interface CartValue {
  lines: CartLine[];
  count: number;
  total: number;
  add(product: Product): void;
  remove(id: string): void;
  setQuantity(id: string, quantity: number): void;
  clear(): void;
}

const CartContext = createContext<CartValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const value = useMemo<CartValue>(
    () => ({
      lines,
      count: lines.reduce((sum, line) => sum + line.quantity, 0),
      total: lines.reduce((sum, line) => sum + line.quantity * line.product.price, 0),
      add(product) {
        console.log('Added to cart:', product.id);
        setLines((current) => {
          const existing = current.find((line) => line.product.id === product.id);
          if (!existing) return [...current, { product, quantity: 1 }];
          return current.map((line) => (line === existing ? { ...line, quantity: line.quantity + 1 } : line));
        });
      },
      remove(id) {
        console.info('Removed from cart:', id);
        setLines((current) => current.filter((line) => line.product.id !== id));
      },
      setQuantity(id, quantity) {
        setLines((current) =>
          quantity <= 0
            ? current.filter((line) => line.product.id !== id)
            : current.map((line) => (line.product.id === id ? { ...line, quantity } : line)),
        );
      },
      clear() {
        setLines([]);
      },
    }),
    [lines],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const value = useContext(CartContext);
  if (!value) throw new Error('useCart must be used inside CartProvider');
  return value;
}
