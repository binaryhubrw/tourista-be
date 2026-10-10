const KIGALI_OFFSET_MS = 2 * 3_600_000; // Africa/Kigali is UTC+2, no DST.

/** Today's date in Africa/Kigali as YYYY-MM-DD. */
export const todayIso = () => new Date(Date.now() + KIGALI_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Earliest date a booking may start on. The frontend computes "today" in UTC, which lags Kigali by up to
 * two hours; accepting the UTC date means no date the UI offers is rejected by the server.
 */
export const bookableFrom = () => new Date().toISOString().slice(0, 10);

export const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
