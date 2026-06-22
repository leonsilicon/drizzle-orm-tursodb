/**
 * Whether a libsql URL points at a local `tursodb --sync-server` (dev) rather
 * than cloud Turso. A local server is always reached over a loopback host
 * (`127.0.0.1` / `localhost` / `[::1]`), on either the `libsql://` or
 * `http(s)://` scheme; cloud Turso uses `libsql://…turso.io`.
 *
 * Use this to choose between this package's transactionless `drizzle(...)` (for
 * local tursodb) and the official `drizzle-orm/libsql` (for cloud Turso).
 */
const LOCAL_TURSO_URL_PATTERN =
  /^(?:libsql|https?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/i;

export function isLocalTursoUrl(url: string): boolean {
  return LOCAL_TURSO_URL_PATTERN.test(url);
}
