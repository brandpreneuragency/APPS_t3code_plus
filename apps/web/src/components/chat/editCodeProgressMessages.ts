export const EDIT_CODE_PROGRESS_MESSAGES = [
  "Giving code a polish",
  "Smoothing out code bumps",
  "Tidying up the logic",
  "Sprucing up the functions",
  "Shaping a fresh fix",
  "Mending the tricky bits",
  "Adding some code sparkle",
  "Fine tuning the flow",
  "Stitching code together",
  "Weaving in the changes",
] as const;

function stableHash(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}

/** Selects a stable message for a turn without using randomness during render. */
export function getEditCodeProgressMessage(seed: string | null): string {
  if (seed === null) return EDIT_CODE_PROGRESS_MESSAGES[0];
  return (
    EDIT_CODE_PROGRESS_MESSAGES[stableHash(seed) % EDIT_CODE_PROGRESS_MESSAGES.length] ??
    EDIT_CODE_PROGRESS_MESSAGES[0]
  );
}
