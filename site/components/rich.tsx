import { Fragment } from 'react';

/** Renders dictionary text, turning `backtick spans` into inline code. Nothing else is parsed. */
export function Rich({ text, codeClassName = 'font-mono text-[0.92em] text-ink' }: { text: string; codeClassName?: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
          <code key={i} className={codeClassName}>
            {part.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** Plain text of a dictionary value (backticks removed), for attributes such as aria-label. */
export function plain(text: string): string {
  return text.replace(/`([^`]+)`/g, '$1');
}
