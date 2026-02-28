export function appendAttachmentMarkers(
  content: string,
  attachmentPaths: readonly string[],
): string {
  if (attachmentPaths.length === 0) {
    return content;
  }

  const markerLine = attachmentPaths.map((path) => `<attachment:${path}>`).join(" ");
  if (content.length === 0) {
    return markerLine;
  }

  return `${content}\n${markerLine}`;
}
