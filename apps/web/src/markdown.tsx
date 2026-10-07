import type { ReactNode } from 'react';

/**
 * A small Markdown renderer for integration documentation. It builds React elements (never
 * HTML strings), so documentation can never inject markup or scripts. Supported: headings,
 * paragraphs, lists, fenced code, tables, inline code, bold, italics and links. Only http(s)
 * links are clickable; relative links point into the repository and are shown as text.
 */
export function Markdown({ source }: { source: string }) {
  return <div className="markdown">{blocks(source.replaceAll('\r\n', '\n'))}</div>;
}

function blocks(text: string): ReactNode[] {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => `b${out.length}`;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      out.push(
        <pre key={key()}>
          <code>{dedent(code).join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      // Page headings are h1 and h2; documentation headings start at h3.
      const level = Math.min(6, heading[1]!.length + 2);
      const Tag = `h${level}` as 'h3';
      out.push(<Tag key={key()}>{inline(heading[2]!)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        const cells = lines[i]!.trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        <table key={key()}>
          {head && (
            <thead>
              <tr>
                {head.map((c, n) => (
                  <th key={n} scope="col">
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {body.map((r, n) => (
              <tr key={n}>
                {r.map((c, m) => (
                  <td key={m}>{inline(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    const bullet = /^\s*([-*]|\d+\.)\s+/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const item = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i]!);
        if (item) {
          items.push(item[2]!);
        } else if (/^\s{2,}\S/.test(lines[i]!) && items.length > 0 && !/^\s*```/.test(lines[i]!)) {
          items[items.length - 1] = `${items.at(-1)!} ${lines[i]!.trim()}`;
        } else {
          break;
        }
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      out.push(
        <List key={key()}>
          {items.map((t, n) => (
            <li key={n}>{inline(t)}</li>
          ))}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^(#{1,6}\s|\s*```|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i]!)
    ) {
      para.push(lines[i++]!.trim());
    }
    out.push(<p key={key()}>{inline(para.join(' '))}</p>);
  }
  return out;
}

function dedent(lines: string[]): string[] {
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
  return Number.isFinite(indent) ? lines.map((l) => l.slice(indent)) : lines;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(_[^_]+_)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const k = `i${out.length}`;
    if (m[1]) {
      out.push(<code key={k}>{token.slice(1, -1)}</code>);
    } else if (m[2]) {
      out.push(<strong key={k}>{inline(token.slice(2, -2))}</strong>);
    } else if (m[3]) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
      const label = inline(link[1]!);
      out.push(
        /^https?:\/\//.test(link[2]!) ? (
          <a key={k} href={link[2]} target="_blank" rel="noreferrer noopener">
            {label}
          </a>
        ) : (
          <span key={k}>{label}</span>
        ),
      );
    } else {
      out.push(<em key={k}>{token.slice(1, -1)}</em>);
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
