/** Content types the snapshot upload accepts; anything else is sent as octet-stream. */
export const ALLOWED_UPLOAD_TYPES = [
  'text/csv',
  'text/plain',
  'application/x-ndjson',
  'application/octet-stream',
  'application/json',
];

export function uploadContentType(file: { name: string; type: string }, override = ''): string {
  if (override && ALLOWED_UPLOAD_TYPES.includes(override)) return override;
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.ndjson') || name.endsWith('.jsonl')) return 'application/x-ndjson';
  if (name.endsWith('.txt')) return 'text/plain';
  const t = (file.type || '').split(';')[0] ?? '';
  return ALLOWED_UPLOAD_TYPES.includes(t) ? t : 'application/octet-stream';
}
