/** Append a message to the rawContent array (if it's a text-block array). Returns mutated content or undefined. */
export function appendToContent(
  rawContent: unknown,
  message: string
): { content: Array<{ type: "text"; text: string }> } | undefined {
  if (!Array.isArray(rawContent) || rawContent.length < 1 || rawContent[0]?.type !== "text") {
    return undefined;
  }
  const textBlock = rawContent[0] as { type: "text"; text: string };
  textBlock.text += message;
  return { content: [{ type: "text" as const, text: textBlock.text }] };
}
