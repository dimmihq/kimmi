import { useEffect, useState } from 'react';

export interface Product {
  id: string;
  name: string;
  price: number;
  color: string;
  category: string;
  description: string;
}

let cache: Promise<Product[]> | null = null;

function loadProducts(): Promise<Product[]> {
  cache ??= fetch('/products.json').then((response) => {
    if (!response.ok) throw new Error(`Could not load products (${response.status})`);
    return response.json() as Promise<Product[]>;
  });
  return cache;
}

export function useProducts(): Product[] | null {
  const [products, setProducts] = useState<Product[] | null>(null);
  useEffect(() => {
    let live = true;
    loadProducts()
      .then((list) => {
        if (live) setProducts(list);
      })
      .catch((error: unknown) => console.error('Catalogue failed to load', error));
    return () => {
      live = false;
    };
  }, []);
  return products;
}

export function formatPrice(value: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value);
}
