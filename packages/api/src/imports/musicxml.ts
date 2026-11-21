import { inflateRawSync } from 'node:zlib';
import { ImportError, attr, childElements, firstChild, musicXmlToScore, parseXml } from '@sibei/codec';

/**
 * The MusicXML upload boundary (SIB2-152), the sibling of `note-events.ts` and `upload.ts` (ADR-0029).
 *
 * The bytes are **untrusted XML**, so this is where they are bounded and proven: a size cap on the text,
 * a cap on what a compressed `.mxl` may expand to (a zip bomb is the attack, so the inflate itself is
 * bounded, not checked afterwards), the codec's nesting cap and its refusal to expand declared entities,
 * and a dry run of the real importer so that what is stored is known to import. A refusal is **distinct and
 * non-retryable** (the same bytes would be refused again): it never becomes a job, the route answers 422,
 * and nothing is stored. What passes is stored as the *plain XML text* (an `.mxl` is unpacked here), so the
 * runner never sees an archive.
 */

/** The marker a MusicXML job carries in `ImportJob.engine`, the way NoteEvents' does (no schema change). */
export const MUSICXML_SOURCE = 'musicxml';

/** 10 MB of XML. A large orchestral score is a few MB; a lead sheet is tens of KB. */
export const MAX_MUSICXML_BYTES = 10_000_000;

export type MusicXmlRejection = 'malformed' | 'unsupported' | 'too-large';

export type MusicXmlCheck =
  | { ok: true; xml: Buffer; warnings: string[] }
  | { ok: false; reason: MusicXmlRejection; message: string };

export function validateMusicXmlUpload(bytes: Buffer): MusicXmlCheck {
  let xmlBytes = bytes;
  if (isZip(bytes)) {
    const unpacked = unpackMxl(bytes);
    if (typeof unpacked === 'string') return refuse('malformed', unpacked);
    xmlBytes = unpacked;
  }
  if (xmlBytes.length > MAX_MUSICXML_BYTES) {
    return refuse('too-large', `the MusicXML is larger than ${MAX_MUSICXML_BYTES} bytes`);
  }
  try {
    const { warnings } = musicXmlToScore(decode(xmlBytes), { id: 'check' });
    return { ok: true, xml: xmlBytes, warnings };
  } catch (error) {
    if (error instanceof ImportError) return refuse(error.kind, error.message);
    // The codec answers a hostile document with an `ImportError`; anything else is a defect there, but it
    // is still this *file's* refusal, never a 500.
    return refuse('malformed', 'the document could not be read as MusicXML');
  }
}

/** The text the codec reads: UTF-8, without a byte-order mark. The runner decodes stored bytes the same way. */
export function decode(bytes: Buffer): string {
  return bytes.toString('utf8').replace(/^﻿/, '');
}

function refuse(reason: MusicXmlRejection, message: string): MusicXmlCheck {
  return { ok: false, reason, message };
}

function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
}

/**
 * Read the score out of a compressed `.mxl` (a zip whose `META-INF/container.xml` names the root file).
 * Only what MusicXML uses is read: stored and deflated entries, no encryption, no zip64. Returns the XML
 * bytes, or the reason it could not.
 */
function unpackMxl(zip: Buffer): Buffer | string {
  const entries = readDirectory(zip);
  if (typeof entries === 'string') return entries;
  const read = (name: string): Buffer | string | null => {
    const entry = entries.find((e) => e.name === name);
    return entry === undefined ? null : extract(zip, entry);
  };

  let rootPath: string | null = null;
  const container = read('META-INF/container.xml');
  if (typeof container === 'string') return container;
  if (container !== null) {
    try {
      const rootfiles = firstChild(parseXml(decode(container)), 'rootfiles');
      const first = rootfiles === null ? undefined : childElements(rootfiles, 'rootfile')[0];
      rootPath = first === undefined ? null : attr(first, 'full-path');
    } catch {
      return 'the .mxl container.xml is not valid XML';
    }
  }
  rootPath ??= entries.find((e) => !e.name.startsWith('META-INF/') && /\.(xml|musicxml)$/i.test(e.name))?.name ?? null;
  if (rootPath === null) return 'the .mxl archive holds no MusicXML file';
  const root = read(rootPath);
  return root ?? `the .mxl archive does not contain ${rootPath}`;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const NOT_A_ZIP = 'the .mxl archive is not a readable zip';

function readDirectory(zip: Buffer): ZipEntry[] | string {
  // The end-of-central-directory record is within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return NOT_A_ZIP;
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count && n < 1000; n += 1) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) return NOT_A_ZIP;
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    if (zip.readUInt16LE(at + 8) & 1) return 'the .mxl archive is encrypted';
    entries.push({
      name: zip.toString('utf8', at + 46, at + 46 + nameLength),
      method: zip.readUInt16LE(at + 10),
      compressedSize: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      offset: zip.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extract(zip: Buffer, entry: ZipEntry): Buffer | string {
  const tooLarge = `the MusicXML is larger than ${MAX_MUSICXML_BYTES} bytes`;
  if (entry.size > MAX_MUSICXML_BYTES) return tooLarge;
  if (entry.offset + 30 > zip.length || zip.readUInt32LE(entry.offset) !== 0x04034b50) return NOT_A_ZIP;
  const start = entry.offset + 30 + zip.readUInt16LE(entry.offset + 26) + zip.readUInt16LE(entry.offset + 28);
  const data = zip.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.length > MAX_MUSICXML_BYTES ? tooLarge : data;
  if (entry.method !== 8) return 'the .mxl archive uses an unsupported compression method';
  try {
    // The declared size is the attacker's claim; the inflate is capped regardless of it.
    return inflateRawSync(data, { maxOutputLength: MAX_MUSICXML_BYTES });
  } catch {
    return `the .mxl entry ${entry.name} is corrupt or expands past ${MAX_MUSICXML_BYTES} bytes`;
  }
}
