const pad = (value, length = 2) => String(value).padStart(length, '0');

// Round once before splitting, so fractions carry into the next second correctly.
// Integer seconds + microseconds avoids losing precision in Date's millisecond storage.
export function formatCaptureTimestamp(time, utc = false) {
  if (time === null || !Number.isFinite(time)) return '—';
  let seconds = Math.floor(time);
  let micros = Math.round((time - seconds) * 1e6);
  if (micros >= 1e6) { seconds++; micros = 0; }
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return '—';
  const get = field => date[`${utc ? 'getUTC' : 'get'}${field}`]();
  const year = get('FullYear');
  const yearText = year >= 0 && year <= 9999 ? pad(year, 4) : `${year < 0 ? '-' : '+'}${pad(Math.abs(year), 6)}`;
  return `${yearText}-${pad(get('Month') + 1)}-${pad(get('Date'))} ${pad(get('Hours'))}:${pad(get('Minutes'))}:${pad(get('Seconds'))}.${pad(micros, 6)}`;
}

export function captureUtcOffset(time) {
  if (time === null || !Number.isFinite(time)) return 'UTC';
  const offset = -new Date(time * 1000).getTimezoneOffset();
  if (!Number.isFinite(offset)) return 'UTC';
  return `UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
