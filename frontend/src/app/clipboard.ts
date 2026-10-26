import { decodeBase64, decodeBase64Text, stripBearerToken } from '../components/shared';

export function detectBase64(s: string): 'text' | 'image' | null {
  const data = /^data:[^,]+;base64,([A-Za-z0-9+/_=-]+)$/i.exec(s);
  const raw = data?.[1] ?? s;
  const isDataUrl = Boolean(data);
  if (
    raw.length < 4 ||
    raw.length > 16 * 1024 * 1024 ||
    raw.includes('.') ||
    !/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)
  )
    return null;
  const decoded = decodeBase64(raw);
  if (decoded === null) return null;
  try {
    const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    const image =
      bytes.length > 8 &&
      ((bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) ||
        (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
        String.fromCharCode(...bytes.slice(0, 6)).startsWith('GIF') ||
        String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP');
    if (image) return 'image';
    return isDataUrl || decodeBase64Text(raw) !== null ? 'text' : null;
  } catch {
    return null;
  }
}

export function detectJwt(s: string): boolean {
  const parts = stripBearerToken(s).split('.');
  if (parts.length !== 3) return false;
  const object = (seg: string) => {
    const d = decodeBase64Text(seg);
    if (d === null) return false;
    try {
      const v = JSON.parse(d);
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    } catch {
      return false;
    }
  };
  return object(parts[0]) && object(parts[1]);
}
