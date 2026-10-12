/** Self-contained SVG export of a board document. */

const FONT = 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const escapeXml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));

function color(value, fallback = '#FFFFFF') {
  const input = String(value ?? '').trim();
  return /^(?:#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+-]+\)|[a-z]+)$/i.test(input) && !/^(?:inherit|initial|unset)$/i.test(input) ? input : fallback;
}

function imageSource(value) {
  const source = String(value || '').trim();
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[A-Za-z\d+/=\s]+$/i.test(source)) return source;
  try {
    const url = new URL(source);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* Unsupported and invalid image URLs are omitted. */ }
  return '';
}

function linkSource(value) {
  try {
    const url = new URL(String(value || ''));
    if (['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Invalid and unsafe links are not clickable in the export. */ }
  return '';
}

function geometry(object) {
  return {
    x: number(object.x), y: number(object.y),
    width: Math.max(1, number(object.width, 200)),
    height: Math.max(1, number(object.height, 170)),
  };
}

function center(object) {
  const { x, y, width, height } = geometry(object);
  return { x: x + width / 2, y: y + height / 2 };
}

function edgePoint(object, toward) {
  const rect = geometry(object);
  const mid = center(object);
  const dx = toward.x - mid.x;
  const dy = toward.y - mid.y;
  if (!dx && !dy) return mid;
  const scale = Math.min(dx ? rect.width / (2 * Math.abs(dx)) : Infinity, dy ? rect.height / (2 * Math.abs(dy)) : Infinity);
  return { x: mid.x + dx * scale, y: mid.y + dy * scale };
}

function linesFor(text, width, fontSize) {
  const maxChars = Math.max(2, Math.floor(width / (fontSize * 0.54)));
  return String(text || '').split('\n').flatMap(paragraph => {
    if (!paragraph) return [''];
    const words = paragraph.split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words) {
      if (current && `${current} ${word}`.length > maxChars) { lines.push(current); current = ''; }
      current = current ? `${current} ${word}` : word;
    }
    if (current) lines.push(current);
    return lines;
  });
}

function textBlock(text, x, y, width, height, options = {}) {
  const fontSize = clamp(number(options.fontSize, 18), 8, 120);
  const lineHeight = fontSize * number(options.lineHeight, 1.3);
  let lines = linesFor(text, width, fontSize);
  const availableLines = Math.max(1, Math.floor(height / lineHeight));
  if (lines.length > availableLines) {
    lines = lines.slice(0, availableLines);
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/\s+\S*$/, '')}…`;
  }
  const centered = options.align === 'center';
  const firstY = y + (options.verticalCenter ? Math.max(0, (height - lines.length * lineHeight) / 2) : 0) + fontSize;
  const anchorX = centered ? x + width / 2 : x;
  return `<text fill="${color(options.color, '#302C3D')}" font-family="${escapeXml(FONT)}" font-size="${fontSize}" font-weight="${number(options.fontWeight, 400)}" text-anchor="${centered ? 'middle' : 'start'}">${lines.map((line, index) => `<tspan x="${anchorX}" y="${firstY + index * lineHeight}">${escapeXml(line)}</tspan>`).join('')}</text>`;
}

function pointsFor(object) {
  if (!Array.isArray(object.points)) return [];
  return object.points.map(point => Array.isArray(point)
    ? { x: number(point[0]), y: number(point[1]) }
    : { x: number(point?.x), y: number(point?.y) });
}

function render(object, objectMap) {
  const { x, y, width, height } = geometry(object);
  const fill = color(object.color, '#FFE79A');
  const stroke = color(object.stroke || object.strokeColor, '#524B70');
  const text = object.text || '';
  const rotate = number(object.rotation);
  let body = '';
  if (object.type === 'frame') {
    const frameIndex = [...objectMap.values()].filter(item => item.type === 'frame').findIndex(item => item.id === object.id);
    const accent = ['#D1AF6D', '#B3A4C7', '#88B99B'][Math.max(0, frameIndex) % 3];
    const label = String(text).replace(/^\d{2}\s+/, '');
    body = `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" fill="${fill}" stroke="${color(object.stroke, '#CBC3BE')}" stroke-width="1.5"/><rect x="${x}" y="${y - 37}" width="23" height="23" rx="6" fill="${accent}"/><text x="${x + 11.5}" y="${y - 21}" text-anchor="middle" fill="#FFFFFF" font-family="${escapeXml(FONT)}" font-size="10" font-weight="600">${String(frameIndex + 1).padStart(2, '0')}</text>${textBlock(label, x + 33, y - 37, Math.max(1, width - 33), 29, { fontSize: 18, fontWeight: 700, color: '#292B36' })}`;
  } else if (object.type === 'note') {
    const voteCount = Object.values(object.votes || {}).reduce((sum, count) => sum + Math.max(0, number(count)), 0);
    body = `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="3" fill="${fill}" filter="url(#note-shadow)"/>`;
    const textWidth = Math.max(1, width - 40), textHeight = Math.max(1, height - 71);
    let fontSize = clamp(number(object.fontSize, 17), 11, 120);
    while (fontSize > 11 && linesFor(text, textWidth, fontSize).length * fontSize * 1.48 > textHeight) fontSize -= 0.5;
    body += textBlock(text, x + 20, y + 23, textWidth, textHeight, { fontSize, lineHeight: 1.48, color: '#393447' });
    if (object.author) body += `<circle cx="${x + 28}" cy="${y + height - 22}" r="12" fill="#FFFFFF" fill-opacity="0.48"/><text x="${x + 28}" y="${y + height - 18}" text-anchor="middle" font-family="${escapeXml(FONT)}" font-size="9" font-weight="700" fill="#5A5265">${escapeXml(String(object.author).slice(0, 3))}</text>`;
    if (voteCount) body += `<rect x="${x + width - 48}" y="${y + height - 35}" width="34" height="24" rx="12" fill="#FFFFFF" fill-opacity="0.65"/><text x="${x + width - 31}" y="${y + height - 19}" text-anchor="middle" font-family="${escapeXml(FONT)}" font-size="11" fill="#5A5265">♥ ${voteCount}</text>`;
  } else if (object.type === 'text') {
    body = textBlock(text, x, y, width, height, { fontSize: number(object.fontSize, 28), fontWeight: object.fontWeight, color: object.color });
  } else if (object.type === 'shape') {
    const attributes = `fill="${fill}" stroke="${stroke}" stroke-width="${clamp(number(object.strokeWidth, 1.5), 0, 20)}"`;
    if (object.shape === 'ellipse') body = `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2}" ry="${height / 2}" ${attributes}/>`;
    else if (object.shape === 'diamond') body = `<polygon points="${x + width / 2},${y} ${x + width},${y + height / 2} ${x + width / 2},${y + height} ${x},${y + height / 2}" ${attributes}/>`;
    else body = `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${number(object.radius, 12)}" ${attributes}/>`;
    body += textBlock(text, x + 16, y + 12, width - 32, height - 24, { fontSize: number(object.fontSize, 18), align: 'center', verticalCenter: true });
  } else if (object.type === 'connector') {
    const fromObject = objectMap.get(object.from);
    const toObject = objectMap.get(object.to);
    const start = fromObject ? edgePoint(fromObject, toObject ? center(toObject) : { x: x + width, y: y + height }) : { x, y };
    const end = toObject ? edgePoint(toObject, fromObject ? center(fromObject) : start) : { x: x + width, y: y + height };
    const lineColor = color(object.color, '#7C729D');
    const dx = end.x - start.x;
    const curve = object.curved === true ? `M ${start.x} ${start.y} C ${start.x + dx / 2} ${start.y}, ${end.x - dx / 2} ${end.y}, ${end.x} ${end.y}` : `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
    body = `<path d="${curve}" fill="none" stroke="${lineColor}" stroke-width="${clamp(number(object.strokeWidth, 2.5), 0.5, 20)}" marker-end="url(#arrow-head)"/>`;
    if (text) body += textBlock(text, (start.x + end.x) / 2 - 70, (start.y + end.y) / 2 - 28, 140, 28, { fontSize: 13, align: 'center', color: lineColor });
  } else if (object.type === 'image') {
    const source = imageSource(object.src || object.url);
    if (source) body = `<image x="${x}" y="${y}" width="${width}" height="${height}" href="${escapeXml(source)}" xlink:href="${escapeXml(source)}" preserveAspectRatio="xMidYMid meet"/>`;
  } else if (object.type === 'link') {
    const source = linkSource(object.url || object.href);
    let address = source;
    try { address = new URL(source).hostname.replace(/^www\./, '') || source; } catch { /* A label still renders without a URL. */ }
    body = `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="${color(object.color, '#FFFFFF')}" stroke="#DDD8EA"/>`;
    body += `<text x="${x + 18}" y="${y + 28}" fill="#7A5ABD" font-family="${escapeXml(FONT)}" font-size="18">↗</text>`;
    body += textBlock(text || object.title || 'Lien web', x + 18, y + 40, Math.max(1, width - 36), Math.max(1, height - 76), { fontSize: number(object.fontSize, 17), fontWeight: 600 });
    body += textBlock(address, x + 18, y + height - 30, Math.max(1, width - 36), 24, { fontSize: 12, color: '#8A829A' });
    if (source) body = `<a href="${escapeXml(source)}" xlink:href="${escapeXml(source)}" target="_blank">${body}</a>`;
  } else if (object.type === 'draw') {
    const points = pointsFor(object);
    if (points.length) body = `<polyline points="${points.map(point => `${point.x},${point.y}`).join(' ')}" fill="none" stroke="${color(object.color, '#6153A5')}" stroke-width="${clamp(number(object.strokeWidth, 3), 0.5, 40)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return rotate && object.type !== 'connector' ? `<g transform="rotate(${rotate} ${x + width / 2} ${y + height / 2})">${body}</g>` : body;
}

export function boardToSvg(board) {
  const objects = Array.isArray(board?.objects) ? board.objects.filter(object => object && typeof object === 'object') : [];
  const objectMap = new Map(objects.map(object => [object.id, object]));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const object of objects) {
    if (object.type === 'connector' && objectMap.has(object.from) && objectMap.has(object.to)) continue;
    const rect = geometry(object);
    const angle = number(object.rotation) * Math.PI / 180;
    const rotatedWidth = Math.abs(rect.width * Math.cos(angle)) + Math.abs(rect.height * Math.sin(angle));
    const rotatedHeight = Math.abs(rect.width * Math.sin(angle)) + Math.abs(rect.height * Math.cos(angle));
    const centerX = rect.x + rect.width / 2, centerY = rect.y + rect.height / 2;
    minX = Math.min(minX, centerX - rotatedWidth / 2); minY = Math.min(minY, centerY - rotatedHeight / 2);
    if (object.type === 'frame') minY = Math.min(minY, rect.y - 42);
    maxX = Math.max(maxX, centerX + rotatedWidth / 2); maxY = Math.max(maxY, centerY + rotatedHeight / 2);
    for (const point of pointsFor(object)) {
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    }
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 1200; maxY = 800; }
  const padding = 48;
  const viewX = minX - padding, viewY = minY - padding;
  const width = Math.ceil(maxX - minX + padding * 2);
  const height = Math.ceil(maxY - minY + padding * 2);
  const frames = objects.filter(object => object.type === 'frame');
  const connectors = objects.filter(object => object.type === 'connector');
  const others = objects.filter(object => object.type !== 'frame' && object.type !== 'connector');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="${viewX} ${viewY} ${width} ${height}"><title>${escapeXml(board?.title || 'Tableau')}</title><desc>${escapeXml(board?.description || 'Export du tableau collaboratif')}</desc><defs><filter id="note-shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#33294E" flood-opacity="0.09"/></filter><marker id="arrow-head" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M 1 1 L 8 5 L 1 9" fill="none" stroke="#7C729D" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs><rect x="${viewX}" y="${viewY}" width="${width}" height="${height}" fill="#FAFAFC"/>${[...frames, ...connectors, ...others].map(object => render(object, objectMap)).join('')}</svg>`;
}

export function downloadFile(name, content, type = 'text/plain;charset=utf-8') {
  const file = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = String(name || 'export').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-');
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
