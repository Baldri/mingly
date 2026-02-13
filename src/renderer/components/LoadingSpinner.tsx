/**
 * Lightweight Suspense fallback for lazy-loaded components.
 * Keeps the initial bundle small by avoiding heavy dependencies.
 */
export function LoadingSpinner({ label }: { label?: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-white dark:bg-gray-900">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500 dark:border-gray-600 dark:border-t-blue-400" />
        {label && (
          <span className="text-sm text-gray-500 dark:text-gray-400">{label}</span>
        )}
      </div>
    </div>
  )
}
