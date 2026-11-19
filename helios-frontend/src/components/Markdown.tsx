"use client";

import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CitationChip, hasCites, parseCited, type Cite } from "./Citation";

/** Agent prose: GFM markdown styled to match chat (15px / 1.7). */
export function Markdown({ children }: { children: string }) {
  // Citations [[source | url | evidence]] become links to "cite:<n>", which
  // the link renderer turns into chips.
  const cites: Cite[] = [];
  const source = hasCites(children)
    ? parseCited(children)
        .map((p) => {
          if (p.kind === "text") return p.text;
          cites[p.n - 1] = p.cite;
          return `[${p.n}](cite:${p.n})`;
        })
        .join("")
    : children;
  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) =>
          url.startsWith("cite:") ? url : defaultUrlTransform(url)
        }
        components={{
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="mb-3 list-disc space-y-1.5 pl-6 last:mb-0 marker:text-ink">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 list-decimal space-y-1.5 pl-6 last:mb-0 marker:text-ink">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="leading-[1.7]">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ href, children }) =>
            href?.startsWith("cite:") && cites[Number(href.slice(5)) - 1] ? (
              <CitationChip
                n={Number(href.slice(5))}
                cite={cites[Number(href.slice(5)) - 1]}
              />
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-sky-ink underline decoration-sky-ink/30 underline-offset-2 hover:decoration-sky-ink"
              >
                {children}
              </a>
            ),
          h1: ({ children }) => (
            <h3 className="mt-4 mb-2 font-semibold first:mt-0">{children}</h3>
          ),
          h2: ({ children }) => (
            <h3 className="mt-4 mb-2 font-semibold first:mt-0">{children}</h3>
          ),
          h3: ({ children }) => (
            <h3 className="mt-3 mb-1.5 font-semibold first:mt-0">{children}</h3>
          ),
          code: ({ className, children }) => {
            const block = !!className;
            if (block) {
              return (
                <code className="block overflow-x-auto rounded-lg bg-subtle px-3 py-2 font-mono text-[13px] leading-relaxed">
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-subtle px-1 py-0.5 font-mono text-[0.9em]">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-3 overflow-x-auto last:mb-0">{children}</pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-3 border-l-2 border-line pl-3 text-muted last:mb-0">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-line" />,
          table: ({ children }) => (
            <div className="mb-3 overflow-x-auto last:mb-0">
              <table className="w-full border-collapse text-left text-[14px]">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-line px-2 py-1.5 font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-hairline px-2 py-1.5 align-top">
              {children}
            </td>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
