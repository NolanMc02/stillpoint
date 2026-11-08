// Build a past-only snapshot. Never include the rest of the current paragraph,
// later chapter titles, or any words beyond the selected reading position.
export function buildStoryPrompt({ book, words, glue = [], chapterStarts = [], position, kind = 'scene' }) {
  if (!words?.length) throw new Error('There is no reading text to explain.');
  const cutoff = Math.max(0, Math.min(words.length - 1, Math.floor(position || 0)));
  let chapterIndex = -1;
  for (let i = 0; i < chapterStarts.length; i++) if (chapterStarts[i] <= cutoff) chapterIndex = i;
  const chapter = chapterIndex < 0 ? null : book.chapters?.[chapterIndex];
  let start = Math.max(0, cutoff - 49);
  while (start < cutoff && words.slice(start, cutoff + 1).join(' ').length > 600) start++;
  const excerpt = words.slice(start, cutoff + 1).map((word, offset) => word + (glue[start + offset] ? '' : ' ')).join('').trim();
  const percent = ((cutoff + 1) / words.length * 100).toFixed(1);
  const chapterLength = chapter ? Math.max(1, (chapterStarts[chapterIndex + 1] ?? words.length) - chapterStarts[chapterIndex]) : 0;
  const chapterPercent = chapter ? Math.min(100, (cutoff - chapterStarts[chapterIndex] + 1) / chapterLength * 100).toFixed(1) : null;
  return `I’m reading ${String(book.title || 'Untitled')}${book.author ? ` by ${book.author}` : ''}, ${chapter ? `in chapter “${chapter.title}”, about ${chapterPercent}% through this chapter and ` : ''}about ${percent}% through the book.

My current passage ends here:
“${excerpt}”

${kind === 'summary' ? 'Can you briefly explain the story from the beginning up to this point?' : 'Can you help me understand what is going on at this point in the story?'} Please use simple language and don’t spoil anything after the quoted text, even later in this chapter.`;
}
