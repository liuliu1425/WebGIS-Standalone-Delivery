/** Recover CF_HTML bytes incorrectly delivered as UTF-16 plain text by a clipboard bridge. */
export function recoverMislabeledHtmlClipboardText(text: string): string | null {
  // Reconstruct code units, not code points: the clipboard decoded every pair
  // of UTF-8 bytes as one little-endian UTF-16 unit before the paste reached us.
  if (text.length < 50 || text.length > 1_000_000) return null
  const bytes = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    bytes[2 * i] = unit & 0xff
    bytes[2 * i + 1] = unit >>> 8
  }
  if (!'Version:'.split('').every((c, i) => bytes[i] === c.charCodeAt(0))) return null
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const decoded = decoder.decode(bytes)
    const field = (name: string) => {
      const match = new RegExp(`(?:^|\\r?\\n)${name}:(\\d+)`).exec(decoded)
      return match ? Number(match[1]) : NaN
    }
    const startHtml = field('StartHTML')
    const endHtml = field('EndHTML')
    const start = field('StartFragment')
    const end = field('EndFragment')
    if (![startHtml, endHtml, start, end].every(Number.isSafeInteger)) return null
    // A bridge may drop an odd final byte of the closing HTML tag. The complete
    // selected fragment and its boundary markers must still be present.
    if (startHtml < 80 || start <= startHtml || end <= start || end > bytes.length) return null
    if (endHtml < end || endHtml > bytes.length + 1) return null
    const prefix = decoder.decode(bytes.subarray(startHtml, start))
    const suffix = decoder.decode(bytes.subarray(end))
    if (!/<!--StartFragment-->$/.test(prefix) || !/^<!--EndFragment-->/.test(suffix)) return null
    const fragment = decoder.decode(bytes.subarray(start, end))
    if (!/[<&]/.test(fragment)) return fragment
    // Parse in a detached inert document and insert only text into the textarea.
    const doc = new DOMParser().parseFromString(fragment, 'text/html')
    doc.querySelectorAll('script,style,template').forEach((node) => node.remove())
    doc.querySelectorAll('br').forEach((node) => node.replaceWith('\n'))
    doc.querySelectorAll('p,div,li,pre').forEach((node) => node.append('\n'))
    return (doc.body.textContent ?? '').replace(/\n$/, '')
  } catch {
    return null
  }
}
