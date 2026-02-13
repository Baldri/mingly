/**
 * Lazy-loaded Markdown renderer.
 *
 * This component is code-split from the main bundle because
 * react-markdown + react-syntax-highlighter add ~250 KB.
 * It is loaded on demand when the first assistant message renders.
 */
import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

interface MarkdownRendererProps {
  content: string
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const components = useMemo(() => ({
    code({ node, inline, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '')
      return !inline && match ? (
        <SyntaxHighlighter
          style={oneDark}
          language={match[1]}
          PreTag="div"
          {...props}
        >
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      ) : (
        <code className={className} {...props}>
          {children}
        </code>
      )
    }
  }), [])

  return (
    <ReactMarkdown components={components}>
      {content}
    </ReactMarkdown>
  )
})

export default MarkdownRenderer
