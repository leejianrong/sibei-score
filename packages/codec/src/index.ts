/**
 * `@sibei/codec` — MusicXML at the edges (ADR-0004).
 *
 * Two entry points, `scoreToMusicXml` and `musicXmlToScore`, plus the XML primitives they share.
 * Framework-free and Node-free like `model` and `music`: it turns a `Score` into a string and a
 * string into a `Score`, and reading and writing files is the CLI's and the API's job, not this
 * package's.
 */

export { scoreToMusicXml } from './export.js';
export { musicXmlToScore, keyFromFifths, ImportError } from './import.js';
export type { ImportResult, ImportOptions } from './import.js';
export {
  parseXml,
  serialize,
  elem,
  leaf,
  isElement,
  childElements,
  firstChild,
  textContent,
  childText,
  attr,
  XmlError,
} from './xml.js';
export type { XmlElement, XmlNode, XmlText } from './xml.js';
