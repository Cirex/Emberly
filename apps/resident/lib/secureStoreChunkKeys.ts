export function secureStoreChunkMetaKey(key: string): string {
  return `${key}_chunks`;
}

export function secureStoreChunkKey(key: string, index: number, generation: number): string {
  return `${key}_chunk_g${generation}_${index}`;
}
