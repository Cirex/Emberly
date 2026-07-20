import * as SecureStore from 'expo-secure-store';
import { secureStoreChunkKey, secureStoreChunkMetaKey } from './secureStoreChunkKeys';

const CHUNK_SIZE = 1900;
// [\s\S] (instead of .) keeps literal newlines, and the u flag matches whole
// code points so a surrogate pair is never bisected across chunks.
const CHUNK_SPLIT_REGEX = new RegExp(`[\\s\\S]{1,${CHUNK_SIZE}}`, 'gu');

interface ChunkMeta {
  count: number;
  generation: number;
}

// Meta value is "<count>:<generation>".
function parseChunkMeta(raw: string | null): ChunkMeta | null {
  if (!raw) return null;

  const match = raw.match(/^(\d+):([12])$/);
  if (!match) return null;

  const count = Number(match[1]);
  if (count <= 0) return null;

  return { count, generation: Number(match[2]) };
}

/**
 * Crash-safe write. Chunks are written to the generation the meta pointer is
 * NOT referencing, then the meta pointer is flipped in a single (atomic)
 * write, then the old generation is cleaned up. A crash at any point leaves
 * either the complete old value or the complete new value readable — never a
 * stitch of the two, for both grow and shrink cases.
 */
export async function setLargeSecureItemAsync(key: string, value: string): Promise<void> {
  const metaKey = secureStoreChunkMetaKey(key);
  const previousMeta = parseChunkMeta(await SecureStore.getItemAsync(metaKey));
  const generation = previousMeta?.generation === 1 ? 2 : 1;
  const chunks = value.match(CHUNK_SPLIT_REGEX) ?? [''];

  // 1. Write the new generation's chunks. Readers still stitch the previous
  //    generation, so a crash here cannot produce a corrupt read.
  await Promise.all(
    chunks.map((chunk, index) =>
      SecureStore.setItemAsync(secureStoreChunkKey(key, index, generation), chunk)
    )
  );

  // 2. Flip the meta pointer — the single commit point.
  await SecureStore.setItemAsync(metaKey, `${chunks.length}:${generation}`);

  // 3. Cleanup: the previous generation's chunks. A crash here only leaves
  //    unreferenced leftovers, which are overwritten or ignored by later
  //    reads/writes.
  const cleanupKeys: string[] = [];
  if (previousMeta) {
    for (let index = 0; index < previousMeta.count; index += 1) {
      cleanupKeys.push(secureStoreChunkKey(key, index, previousMeta.generation));
    }
  }
  await Promise.all(cleanupKeys.map((itemKey) => SecureStore.deleteItemAsync(itemKey)));
}

export async function getLargeSecureItemAsync(key: string): Promise<string | null> {
  const meta = parseChunkMeta(await SecureStore.getItemAsync(secureStoreChunkMetaKey(key)));

  if (!meta) {
    return null;
  }

  const chunks = await Promise.all(
    Array.from({ length: meta.count }, (_, index) =>
      SecureStore.getItemAsync(secureStoreChunkKey(key, index, meta.generation))
    )
  );

  if (chunks.some((chunk) => chunk === null)) {
    return null;
  }

  return chunks.join('');
}

export async function deleteLargeSecureItemAsync(key: string): Promise<void> {
  const meta = parseChunkMeta(await SecureStore.getItemAsync(secureStoreChunkMetaKey(key)));
  const keys = [secureStoreChunkMetaKey(key)];

  if (meta) {
    for (let index = 0; index < meta.count; index += 1) {
      keys.push(secureStoreChunkKey(key, index, meta.generation));
    }
  }

  await Promise.all(keys.map((itemKey) => SecureStore.deleteItemAsync(itemKey)));
}
