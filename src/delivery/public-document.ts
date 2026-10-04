/** Structural Jina Reader envelope checks. These do not establish semantic accuracy. */
export function reviewPublicDocument(text: string, targetUrl: string, requiredTerms: string[], minBytes: number) {
  const bytes = new TextEncoder().encode(text).byteLength;
  const sourceLine = text.match(/^URL Source:\s*(\S+)\s*$/m)?.[1];
  let sourceMatches = false;
  try { sourceMatches = sourceLine !== undefined && new URL(sourceLine).href === new URL(targetUrl).href; }
  catch { /* An invalid or missing source remains a failed check. */ }
  const missingTerms = requiredTerms.filter((term) => !text.toLowerCase().includes(term.toLowerCase()));
  const hasContentEnvelope = /^Markdown Content:\s*$/m.test(text);
  return { bytes, sourceMatches, hasContentEnvelope, missingTerms,
    pass: bytes >= minBytes && sourceMatches && hasContentEnvelope && missingTerms.length === 0 };
}
