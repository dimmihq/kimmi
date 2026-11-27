'use client';

import kimmi from '@kimmi/browser';
import { useEffect } from 'react';

/** Starts kimmi once in the browser. Route changes through next/link are picked up as navigate events. */
export function KimmiInit() {
  useEffect(() => {
    kimmi.init({
      key: process.env.NEXT_PUBLIC_KIMMI_KEY ?? '',
      host: process.env.NEXT_PUBLIC_KIMMI_HOST ?? 'http://localhost:8700',
      release: 'marketing@2.0.0',
    });
  }, []);
  return null;
}
