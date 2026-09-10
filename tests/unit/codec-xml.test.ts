import { describe, expect, it } from 'vitest';
import {
  attr,
  childElements,
  childText,
  elem,
  firstChild,
  leaf,
  parseXml,
  serialize,
  textContent,
  XmlError,
} from '@sibei/codec';

/**
 * The codec's own tiny XML reader/writer (V8b). It exists because the codec is framework-free and
 * Node-free (`tests/arch`) and so may not pull an XML library or lean on a DOM — so the parser is
 * ours, and it earns its own tests: the round-trips below are what the MusicXML codec stands on.
 */

describe('parseXml', () => {
  it('reads elements, attributes, nested children and text', () => {
    const root = parseXml('<a x="1"><b>hi</b><c/></a>');
    expect(root.name).toBe('a');
    expect(attr(root, 'x')).toBe('1');
    expect(childText(root, 'b')).toBe('hi');
    expect(firstChild(root, 'c')?.children).toEqual([]);
  });

  it('skips the prolog, a doctype and comments around and inside the root', () => {
    const doc = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE score-partwise PUBLIC "-//X//DTD//EN" "http://x.dtd">',
      '<!-- a comment -->',
      '<root><!-- inner --><child>v</child></root>',
    ].join('\n');
    const root = parseXml(doc);
    expect(root.name).toBe('root');
    expect(childText(root, 'child')).toBe('v');
  });

  it('decodes the five predefined entities and numeric references', () => {
    const root = parseXml('<t>a &amp; b &lt; c &gt; &quot; &apos; &#65; &#x42;</t>');
    expect(textContent(root)).toBe('a & b < c > " \' A B');
  });

  it('reads CDATA verbatim', () => {
    const root = parseXml('<t><![CDATA[<not> & parsed]]></t>');
    expect(textContent(root)).toBe('<not> & parsed');
  });

  it('accepts single-quoted attributes', () => {
    expect(attr(parseXml("<a b='two words'/>"), 'b')).toBe('two words');
  });

  it('throws XmlError on a mismatched closing tag', () => {
    expect(() => parseXml('<a></b>')).toThrow(XmlError);
  });

  it('throws XmlError on an unclosed element', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(XmlError);
  });
});

describe('serialize', () => {
  it('is deterministic and escapes text and attributes', () => {
    const tree = elem('score', { title: 'a & "b"' }, [leaf('note', 'c < d'), elem('empty', {})]);
    const xml = serialize(tree, { prolog: ['<?xml version="1.0"?>'] });
    expect(xml).toBe(
      [
        '<?xml version="1.0"?>',
        '<score title="a &amp; &quot;b&quot;">',
        '  <note>c &lt; d</note>',
        '  <empty/>',
        '</score>',
        '',
      ].join('\n'),
    );
  });

  it('round-trips through parse: serialise, parse, and the tree matches', () => {
    const tree = elem('a', { k: 'v' }, [leaf('b', 'text'), elem('c', { n: '2' }, [leaf('d', 'x')])]);
    const reparsed = parseXml(serialize(tree));
    expect(reparsed.name).toBe('a');
    expect(attr(reparsed, 'k')).toBe('v');
    expect(childText(reparsed, 'b')).toBe('text');
    expect(childText(firstChild(reparsed, 'c')!, 'd')).toBe('x');
  });

  it('drops undefined attributes and null children so callers can build inline', () => {
    const tree = elem('a', { present: '1', absent: undefined }, [null, 'text', undefined]);
    expect(attr(tree, 'absent')).toBeNull();
    expect(childElements(tree)).toEqual([]);
    expect(textContent(tree)).toBe('text');
  });
});
