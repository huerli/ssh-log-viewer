import React from 'react';

// Remote notes remain text; links and HTML are never interpreted as navigation or markup.
function inline(text: string) {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, index) =>
    part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> :
    part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part);
}
export function ReleaseNotes({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (/^\s*```/.test(line)) {
      const opening = line; const code: string[] = []; index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) code.push(lines[index++]);
      const closed = index < lines.length;
      if (closed) index++;
      blocks.push(<pre key={index}><code>{closed ? code.join('\n') : [opening, ...code].join('\n')}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(<div className={`release-notes-heading level-${heading[1].length}`} role="heading" aria-level={Math.min(heading[1].length + 1, 6)} key={index}>{inline(heading[2])}</div>);
      index++; continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*[-*+]\s+/, ''));
      blocks.push(<ul key={index}>{items.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>);
      continue;
    }
    const paragraph = [line]; index++;
    while (index < lines.length && lines[index].trim() && !/^\s*(?:#{1,6}\s|[-*+]\s|```)/.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={index}>{inline(paragraph.join('\n'))}</p>);
  }
  return <div className="release-notes-content">{blocks}</div>;
}
