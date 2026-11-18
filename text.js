export function titleFromText(text, fallback = '新对话') {
  const cleaned = String(text || '')
    .replace(/https?:\/\/([^\s/?#]+)[^\s]*/gi, (_, host) => ` ${host.replace(/^www\./i, '')} `)
    .replace(/[#>*_`~\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  const chars = Array.from(cleaned);
  return chars.length > 28 ? `${chars.slice(0, 28).join('')}…` : cleaned;
}

export function domainOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

export function asIso(value, fallback = new Date().toISOString()) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}
