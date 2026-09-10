import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { directAttachmentParts, extractOfficeText, materializeAttachment, resolveAttachment } from '../src/attachments.js';

async function writeZip(file, entries) {
  const input = Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, strToU8(text)]));
  await fs.writeFile(file, Buffer.from(zipSync(input, { level: 1 })));
}

test('text documents are attached as text and images as multimodal data', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-attachment-'));
  try {
    const textPath = path.join(workspace, 'notes.md');
    const imagePath = path.join(workspace, 'shot.png');
    await fs.writeFile(textPath, '# Notes\nhello\n', 'utf8');
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

    const text = await resolveAttachment('notes.md', workspace);
    const image = await resolveAttachment('shot.png', workspace);
    const parts = await directAttachmentParts([text, image]);

    assert.equal(text.kind, 'text');
    assert.equal(image.kind, 'image');
    assert.match(parts[0].text, /# Notes/);
    assert.equal(parts[1].inlineData.mimeType, 'image/png');
    assert.equal(parts[1].inlineData.data, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64'));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('PDF is accepted as a document attachment', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-pdf-'));
  try {
    await fs.writeFile(path.join(workspace, 'document.pdf'), Buffer.from('%PDF-1.7\nexample', 'utf8'));
    const attachment = await resolveAttachment('document.pdf', workspace);
    const [part] = await directAttachmentParts([attachment]);
    assert.equal(attachment.kind, 'pdf');
    assert.equal(part.inlineData.mimeType, 'application/pdf');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('DOCX text is extracted safely and materialized as external text for the headless backend', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-docx-'));
  try {
    const file = path.join(workspace, 'requirements.docx');
    await writeZip(file, {
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Build the dashboard</w:t></w:r></w:p><w:p><w:r><w:t>Use port 8080</w:t></w:r></w:p></w:body></w:document>'
    });
    const attachment = await resolveAttachment(file, workspace);
    assert.equal(attachment.kind, 'office');
    assert.match(await extractOfficeText(file, '.docx'), /Build the dashboard/);
    const [part] = await directAttachmentParts([attachment]);
    assert.match(part.text, /Use port 8080/);
    const materialized = await materializeAttachment(attachment, path.join(workspace, 'copy'));
    assert.match(materialized.stagedPath, /\.txt$/);
    assert.match(await fs.readFile(materialized.stagedPath, 'utf8'), /requirements\.docx/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('XLSX shared strings and values are extracted as readable worksheet text', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-xlsx-'));
  try {
    const file = path.join(workspace, 'data.xlsx');
    await writeZip(file, {
      '[Content_Types].xml': '<Types/>',
      'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><t>Alice</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row><row><c t="s"><v>1</v></c></row></sheetData></worksheet>'
    });
    const attachment = await resolveAttachment(file, workspace);
    const [part] = await directAttachmentParts([attachment]);
    assert.match(part.text, /Sheet 1/);
    assert.match(part.text, /Name\t42/);
    assert.match(part.text, /Alice/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('PPTX slides are extracted in slide order', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-pptx-'));
  try {
    const file = path.join(workspace, 'deck.pptx');
    await writeZip(file, {
      '[Content_Types].xml': '<Types/>',
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:sld>'
    });
    const text = await extractOfficeText(file, '.pptx');
    assert.ok(text.indexOf('First slide') < text.indexOf('Second slide'));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('malformed or implausibly expanding Office ZIPs are rejected instead of decompressed blindly', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-office-invalid-'));
  try {
    const file = path.join(workspace, 'bad.docx');
    await fs.writeFile(file, Buffer.from('not-a-zip'));
    const attachment = await resolveAttachment(file, workspace);
    assert.equal(attachment.kind, 'office');
    await assert.rejects(() => directAttachmentParts([attachment]), /valid ZIP container/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('direct API bounds large text attachments while preserving their beginning and end', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-attachment-large-text-'));
  try {
    const file = path.join(workspace, 'large.txt');
    await fs.writeFile(file, `BEGIN-${'x'.repeat(120_000)}-END`, 'utf8');
    const attachment = await resolveAttachment(file, workspace);
    const [part] = await directAttachmentParts([attachment]);
    assert.match(part.text, /BEGIN-/);
    assert.match(part.text, /truncated \d+ characters for direct API context/);
    assert.match(part.text, /-END$/);
    assert.ok(part.text.length < 82_000);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('direct API rejects oversized inline binary attachments before base64 expansion', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-attachment-large-binary-'));
  try {
    const file = path.join(workspace, 'large.pdf');
    await fs.writeFile(file, Buffer.alloc(15 * 1024 * 1024, 1));
    const attachment = await resolveAttachment(file, workspace);
    await assert.rejects(
      () => directAttachmentParts([attachment]),
      /Combined PDF\/image attachments are too large for direct API inline mode/
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
