import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Vendored display names keyed by Metadata path; regenerate with `npm run item-names -- --download`. */
export const ITEM_NAMES_FILE = path.join(import.meta.dirname, '..', 'data', 'item-names.json');

export const REPOE_BASE_ITEMS_URL = 'https://repoe-fork.github.io/base_items.json';

/**
 * Item classes kept from RePoE: those observed on the PoE 1 currency exchange. Paths of other classes get no name
 * and fall back to the Metadata path, which is also what happens for items newer than the snapshot.
 */
export const EXCHANGE_ITEM_CLASSES = [
  'Breachstone',
  'DelveStackableSocketableCurrency',
  'DivinationCard',
  'MapFragment',
  'StackableCurrency',
  'VaultKey',
] as const;

export type ItemNames = ReadonlyMap<string, string>;

export interface ItemNamesSnapshot {
  source: string;
  retrieved_at: string;
  names: Record<string, string>;
}

export async function loadItemNames(file = ITEM_NAMES_FILE): Promise<ItemNames> {
  const snapshot = JSON.parse(await readFile(file, 'utf8')) as ItemNamesSnapshot;
  return new Map(Object.entries(snapshot.names));
}

/** Trims RePoE base_items.json to exchange item classes, sorted by path for stable diffs. */
export function snapshotFromBaseItems(baseItems: unknown, retrievedAt: Date): ItemNamesSnapshot {
  if (typeof baseItems !== 'object' || baseItems === null) throw new Error('base_items.json is not a JSON object');
  const classes = new Set<string>(EXCHANGE_ITEM_CLASSES);
  const names: Record<string, string> = {};
  for (const [itemPath, item] of Object.entries(baseItems).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const { item_class: itemClass, name } = (item ?? {}) as { item_class?: unknown; name?: unknown };
    if (typeof itemClass === 'string' && classes.has(itemClass) && typeof name === 'string' && name.length > 0) {
      names[itemPath] = name;
    }
  }
  return { source: REPOE_BASE_ITEMS_URL, retrieved_at: retrievedAt.toISOString(), names };
}

/** What to show for an item: its display name, or the last segment of its Metadata path when the name is unknown. */
export function itemLabel(metadataPath: string, displayName: string | null | undefined): string {
  return displayName || metadataPath.slice(metadataPath.lastIndexOf('/') + 1);
}
