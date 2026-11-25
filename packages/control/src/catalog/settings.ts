// The closed setting catalog (K2, K35). Each entry is one stable semantic
// setting ID with its definition; operations bind every ID to a handler.
// Rows are added per K35 catalog part (stages D6–D15); none are bound yet.

/** What every setting definition states, independent of its value types. */
export interface SettingDefinitionBase {
  /** Whether the setting can be read; every catalog setting is readable. */
  readonly readable: true;
  /** Whether the setting can be written. */
  readonly writable: boolean;
}

/**
 * The catalog: setting ID to definition. It is a static literal, never
 * extended at runtime (K2: no dynamic registration).
 */
export const settingDefinitions = {} as const satisfies Record<string, SettingDefinitionBase>;

/** A known setting ID. */
export type SettingId = keyof typeof settingDefinitions;

/** The setting IDs, in catalog order. */
export function settingIds(): SettingId[] {
  return Object.keys(settingDefinitions) as SettingId[];
}
