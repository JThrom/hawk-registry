/**
 * Registry schema types.
 *
 * These mirror Hawk's AppEntry / CategoryDef contract. Keep in sync with
 * hawk's src/catalog/types.ts.
 */

export type PackageManagerId =
  | "brew"
  | "apt"
  | "pacman"
  | "cargo"
  | "npm"
  | "bun"
  | "pipx"
  | "pip"
  | "dnf";

export interface AppEntry {
  id: string;
  name: string;
  description: string;
  categories: string[];
  tags?: string[];
  binaries: string[];
  install?: Partial<Record<PackageManagerId, string>>;
  packages?: Partial<Record<PackageManagerId, string>>;
  homepage?: string;
  repo?: string;
  popularity?: number;
  language?: string;
}

export interface CategoryDef {
  id: string;
  name: string;
  order?: number;
}

export interface RegistryIndex {
  /** Schema version of the index format. */
  version: number;
  /** ISO timestamp of the build. */
  generatedAt: string;
  categories: CategoryDef[];
  entries: AppEntry[];
}
