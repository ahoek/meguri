/**
 * Format a number the way the device itself would write it ("5,3" on a Dutch
 * phone, "5.3" on an English one). The undefined locale means the system
 * setting decides, independent of the app's own UI language.
 */
export function localNumber(value: number, decimals = 0): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}
