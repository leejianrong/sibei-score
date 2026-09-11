import { describe, expect, it } from 'vitest';
import { exportRoute, exportUrl, FORMATS } from '@sibei/ui';

/**
 * The export rail's format toggle (V8e) reaches the server by putting `format` in the export query.
 * These pin that the toggle actually changes the URL and the printed route, so the file the rail
 * downloads matches the segment the reader pressed — the "one choice, not two" the rail is built on.
 */

const CONCERT = { format: 'pdf', paper: 'a4', font: 'normal', instrument: 'concert' } as const;

describe('exportUrl carries the chosen format', () => {
  it('defaults to pdf', () => {
    expect(exportUrl('score-1', CONCERT)).toContain('format=pdf');
  });

  it('switches to musicxml when that is chosen', () => {
    const url = exportUrl('score-1', { ...CONCERT, format: 'musicxml' });
    expect(url).toContain('format=musicxml');
    expect(url).not.toContain('format=pdf');
  });

  it('keeps paper, font and a transposing instrument alongside the format', () => {
    const url = exportUrl('score-1', {
      format: 'musicxml',
      paper: 'letter',
      font: 'jazz',
      instrument: 'bb-trumpet',
    });
    expect(url).toContain('format=musicxml');
    expect(url).toContain('paper=letter');
    expect(url).toContain('font=jazz');
    expect(url).toContain('instrument=bb-trumpet');
  });
});

describe('exportRoute prints the same format the URL requests', () => {
  it('shows the chosen format in the query the rail displays', () => {
    expect(exportRoute({ ...CONCERT, format: 'musicxml' }).query).toContain('format=musicxml');
  });
});

describe('the format list the toggle is built from', () => {
  it('offers pdf first and musicxml, with human labels', () => {
    expect(FORMATS.map((f) => f.value)).toEqual(['pdf', 'musicxml']);
    expect(FORMATS.find((f) => f.value === 'musicxml')?.label).toBe('MusicXML');
  });
});
