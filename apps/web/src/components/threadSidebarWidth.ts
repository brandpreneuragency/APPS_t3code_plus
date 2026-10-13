export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
/** Fixed project list beside the thread column. The thread column keeps its previous width. */
export const PROJECT_SCOPE_RAIL_WIDTH = 12 * 16;
const THREAD_COLUMN_DEFAULT_WIDTH = 16 * 16;
const THREAD_COLUMN_MIN_WIDTH = 13 * 16;
const THREAD_SIDEBAR_DEFAULT_WIDTH = THREAD_COLUMN_DEFAULT_WIDTH + PROJECT_SCOPE_RAIL_WIDTH;
export const THREAD_SIDEBAR_MIN_WIDTH = THREAD_COLUMN_MIN_WIDTH + PROJECT_SCOPE_RAIL_WIDTH;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function resolveThreadSidebarMaximumWidth(viewportWidth: number): number {
  return Math.max(
    THREAD_SIDEBAR_MIN_WIDTH,
    Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH,
  );
}

export function resolveInitialThreadSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
): number {
  const preferredWidth =
    storedWidth === null
      ? THREAD_SIDEBAR_DEFAULT_WIDTH
      : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth);
  return Math.min(preferredWidth, resolveThreadSidebarMaximumWidth(viewportWidth));
}
