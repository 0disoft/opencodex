import { COMBO_NAMESPACE } from "../../combos/identifiers";
import { isPlainObject } from "../../lib/plain-data";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "./kinds";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "./native-models";
import { hasOcxRoutedAuthorship } from "./ownership";
import type { RawCatalog, RawEntry } from "./parsing";

/** Internal source evidence, outside the emitted model collection. */
export const NATIVE_INHERITANCE_TEMPLATE_FIELD = "opencodex_native_inheritance_template";

function isSupportedNativeTemplate(row: RawEntry): boolean {
  return typeof row.slug === "string"
    && SUPPORTED_NATIVE_OPENAI_SLUGS.has(row.slug)
    && !row.slug.includes("/")
    && "base_instructions" in row
    && row.opencodex_catalog_kind !== CODEX_NATIVE_ALIAS_CATALOG_KIND
    && row.owned_by !== COMBO_NAMESPACE
    && !hasOcxRoutedAuthorship(row);
}

export function retainedNativeInheritanceTemplate(catalog: RawCatalog | null): RawEntry | null {
  const retained = catalog?.[NATIVE_INHERITANCE_TEMPLATE_FIELD];
  return isPlainObject(retained) && isSupportedNativeTemplate(retained) ? retained : null;
}

/**
 * Inheritance is stricter than catalog validity: unknown bare rows must never lend native
 * eligibility to routed rows (#2813). Retained source evidence uses exactly the same rule.
 * Prefer it over emitted rows so omission of the first native cannot change the next build.
 * No supported source still returns null, preserving the existing null-template behavior.
 */
export function findSupportedNativeTemplate(catalog: RawCatalog | null): RawEntry | null {
  return retainedNativeInheritanceTemplate(catalog)
    ?? catalog?.models?.find(isSupportedNativeTemplate) ?? null;
}

/** Capture before any visibility, capability or ordering projection mutates emitted rows. */
export function captureNativeInheritanceTemplate(catalog: RawCatalog, enabled: boolean): RawEntry | null {
  const template = findSupportedNativeTemplate(catalog);
  if (enabled && template) catalog[NATIVE_INHERITANCE_TEMPLATE_FIELD] = structuredClone(template);
  else delete catalog[NATIVE_INHERITANCE_TEMPLATE_FIELD];
  return template;
}
