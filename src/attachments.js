import fs from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_DIRECT_TEXT_CHARS = 80_000;
const MAX_DIRECT_INLINE_BINARY_BYTES = 14 * 1024 * 1024;
const MAX_OFFICE_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_OFFICE_TEXT_CHARS = 500_000;
const MAX_ZIP_ENTRIES = 5000;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.html', '.htm', '.xml',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log', '.sql', '.css', '.scss', '.less',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.py', '.rb', '.php', '.java',
  '.kt', '.kts', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.go', '.rs', '.swift', '.sh',
  '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.dockerfile', '.env', '.properties'
]);
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);

const MIME_BY_EXTENSION = new Map([
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.json', 'application/json'],
  ['.jsonl', 'application/jsonl'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.xml', 'application/xml'],
  ['.yaml', 'text/yaml'],
  ['.yml', 'text/yaml'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.ts', 'text/plain'],
  ['.tsx', 'text/plain'],
  ['.jsx', 'text/plain']
]);

function unquote(value) {
  const text = String(value || '').trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

async function looksText(file) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return true;
    return !buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function findZipEnd(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function validateZipExpansion(buffer) {
  const end = findZipEnd(buffer);
  if (end < 0) throw new Error('Office document is not a valid ZIP container.');
  const entries = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (entries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error('ZIP64 Office documents are not supported.');
  }
  if (entries > MAX_ZIP_ENTRIES || centralOffset + centralSize > buffer.length) {
    throw new Error('Office document ZIP directory is invalid or too large.');
  }

  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Office document ZIP directory is malformed.');
    }
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if (uncompressed === 0xffffffff) throw new Error('ZIP64 Office documents are not supported.');
    total += uncompressed;
    if (total > MAX_OFFICE_UNCOMPRESSED_BYTES) {
      throw new Error('Office document expands beyond the 50 MB safety limit.');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlText(xml) {
  return decodeXmlEntities(String(xml || '')
    .replace(/<(?:w:br|a:br|br)\b[^>]*\/?\s*>/gi, '\n')
    .replace(/<\/(?:w:p|a:p|row)>/gi, '\n')
    .replace(/<tab\b[^>]*\/?\s*>/gi, '\t')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function entryString(entries, name) {
  const value = entries[name];
  return value ? strFromU8(value) : '';
}

function numberedEntries(entries, pattern) {
  return Object.keys(entries)
    .map((name) => ({ name, match: name.match(pattern) }))
    .filter((item) => item.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
}

function docxText(entries) {
  const names = ['word/document.xml', ...Object.keys(entries)
    .filter((name) => /^word\/(?:header|footer)\d+\.xml$/i.test(name))
    .sort()];
  return names.map((name) => xmlText(entryString(entries, name))).filter(Boolean).join('\n\n');
}

function pptxText(entries) {
  return numberedEntries(entries, /^ppt\/slides\/slide(\d+)\.xml$/i)
    .map((item, index) => {
      const text = xmlText(entryString(entries, item.name));
      return text ? `Slide ${index + 1}\n${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function sharedStrings(entries) {
  const xml = entryString(entries, 'xl/sharedStrings.xml');
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) => xmlText(match[1]));
}

function worksheetText(xml, strings) {
  const rows = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const cells = [];
    for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attrs = cell[1];
      const body = cell[2];
      const type = attrs.match(/\bt=["']([^"']+)["']/i)?.[1] || '';
      const inline = body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/i)?.[1];
      const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1];
      let value = inline !== undefined ? xmlText(inline) : decodeXmlEntities(raw || '').trim();
      if (type === 's' && /^\d+$/.test(value)) value = strings[Number(value)] ?? value;
      if (value) cells.push(value);
    }
    if (cells.length) rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

function xlsxText(entries) {
  const strings = sharedStrings(entries);
  return numberedEntries(entries, /^xl\/worksheets\/sheet(\d+)\.xml$/i)
    .map((item, index) => {
      const text = worksheetText(entryString(entries, item.name), strings);
      return text ? `Sheet ${index + 1}\n${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

export async function extractOfficeText(file, extension = path.extname(file).toLowerCase()) {
  const buffer = await fs.readFile(file);
  validateZipExpansion(buffer);
  let entries;
  try {
    entries = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new Error(`Could not read Office document: ${path.basename(file)}`);
  }

  let text = '';
  if (extension === '.docx') text = docxText(entries);
  else if (extension === '.pptx') text = pptxText(entries);
  else if (extension === '.xlsx') text = xlsxText(entries);
  else throw new Error(`Unsupported Office document type: ${extension}`);
  if (!text) throw new Error(`Office document contains no readable text: ${path.basename(file)}`);
  if (text.length > MAX_OFFICE_TEXT_CHARS) return `${text.slice(0, MAX_OFFICE_TEXT_CHARS)}\n[truncated]`;
  return text;
}

export function attachmentIsText(attachment) {
  return attachment.kind === 'text' || attachment.kind === 'office';
}

export async function materializeAttachment(attachment, target) {
  if (attachment.kind !== 'office') {
    await fs.copyFile(attachment.sourcePath, target);
    return { ...attachment, stagedPath: target };
  }
  const textTarget = `${target}.txt`;
  const text = await extractOfficeText(attachment.sourcePath, path.extname(attachment.sourcePath).toLowerCase());
  await fs.writeFile(textTarget, `Attachment: ${attachment.name}\n\n${text}\n`, 'utf8');
  return { ...attachment, stagedPath: textTarget };
}

export async function resolveAttachment(value, workspace) {
  const requested = unquote(value);
  if (!requested) throw new Error('Attachment path cannot be empty.');

  const sourcePath = path.isAbsolute(requested)
    ? path.normalize(requested)
    : path.resolve(workspace, requested);
  const stat = await fs.stat(sourcePath).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`Attachment not found: ${requested}`);
    throw error;
  });

  if (!stat.isFile()) throw new Error(`Attachment is not a file: ${requested}`);
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB: ${requested}`);
  }

  const extension = path.extname(sourcePath).toLowerCase();
  const mimeType = MIME_BY_EXTENSION.get(extension) || 'application/octet-stream';
  let kind;

  if (extension === '.pdf') kind = 'pdf';
  else if (OFFICE_EXTENSIONS.has(extension)) kind = 'office';
  else if (mimeType.startsWith('image/')) kind = 'image';
  else if (TEXT_EXTENSIONS.has(extension) || mimeType.startsWith('text/') || await looksText(sourcePath)) kind = 'text';
  else kind = 'binary';

  if (kind === 'binary') {
    throw new Error(`Unsupported attachment type: ${path.basename(sourcePath)}. Use an image, PDF, Office, or text/code document.`);
  }

  return {
    sourcePath,
    name: path.basename(sourcePath),
    mimeType: kind === 'text' && mimeType === 'application/octet-stream' ? 'text/plain' : mimeType,
    kind,
    size: stat.size
  };
}

export async function directAttachmentParts(attachments = [], { maxTextChars = MAX_DIRECT_TEXT_CHARS } = {}) {
  const parts = [];
  let totalBytes = 0;
  let totalTextChars = 0;
  let inlineBinaryBytes = 0;
  const textLimit = Math.min(Math.max(Number(maxTextChars) || 0, 0), MAX_DIRECT_TEXT_CHARS);

  const boundedText = (text, name) => {
    const value = String(text || '');
    const remaining = textLimit - totalTextChars;
    if (remaining <= 0) {
      return `[Attachment ${name} omitted from direct inline context because the combined text-attachment limit was reached. Use a smaller attachment set or Google subscription mode to read the complete files.]`;
    }
    if (value.length <= remaining) {
      totalTextChars += value.length;
      return value;
    }
    const marker = `\n[Attachment ${name} truncated ${value.length - remaining} characters for direct API context. Use a smaller attachment or Google subscription mode if omitted details are required.]\n`;
    const available = Math.max(0, remaining - marker.length);
    const tailChars = Math.floor(available / 3);
    const headChars = available - tailChars;
    totalTextChars = textLimit;
    return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
  };

  for (const attachment of attachments) {
    const file = attachment.stagedPath || attachment.sourcePath;
    totalBytes += attachment.size || (await fs.stat(file)).size;
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error('Combined attachments exceed 20 MB for direct API mode.');
    }

    if (attachment.kind === 'office') {
      const text = await extractOfficeText(attachment.sourcePath, path.extname(attachment.sourcePath).toLowerCase());
      parts.push({ text: `\nAttachment: ${attachment.name}\n${boundedText(text, attachment.name)}` });
      continue;
    }

    if (attachmentIsText(attachment)) {
      const text = await fs.readFile(file, 'utf8');
      parts.push({ text: `\nAttachment: ${attachment.name}\n${boundedText(text, attachment.name)}` });
      continue;
    }

    const size = attachment.size || (await fs.stat(file)).size;
    inlineBinaryBytes += size;
    if (inlineBinaryBytes > MAX_DIRECT_INLINE_BINARY_BYTES) {
      throw new Error(`Combined PDF/image attachments are too large for direct API inline mode. Keep them under ${MAX_DIRECT_INLINE_BINARY_BYTES / (1024 * 1024)} MB total or use Google subscription mode.`);
    }
    const data = await fs.readFile(file);
    parts.push({
      inlineData: {
        mimeType: attachment.mimeType,
        data: data.toString('base64')
      }
    });
  }

  return parts;
}

export function attachmentSummary(attachments = []) {
  return attachments.map((attachment) => ({
    name: attachment.name,
    path: attachment.sourcePath,
    mimeType: attachment.mimeType,
    kind: attachment.kind
  }));
}
