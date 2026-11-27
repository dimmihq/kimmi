import { gzipSync } from 'fflate';
import type { BatchMeta } from './types';

const encoder = new TextEncoder();

export function gzipNow(json: string): Uint8Array {
  return gzipSync(encoder.encode(json));
}

/** Gzips off the main thread with `CompressionStream` when the browser has it. */
export async function gzip(json: string): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return gzipNow(json);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `[uint32 BE metadata length][metadata JSON][gzip of the events JSON array]`. */
export function envelope(meta: BatchMeta, compressedEvents: Uint8Array): Uint8Array<ArrayBuffer> {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + metaBytes.length + compressedEvents.length);
  new DataView(out.buffer).setUint32(0, metaBytes.length, false);
  out.set(metaBytes, 4);
  out.set(compressedEvents, 4 + metaBytes.length);
  return out;
}
