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
  | "dnf"
  | "go";

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
  /** Extracted install instructions (markdown) from the README. */
  installNotes?: string;
  /** Raw URL of the full README (sidecar stored in readmes/). */
  readmeUrl?: string;
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
