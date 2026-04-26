export type RuntimeStickerFormat = "apng" | "gif" | "lottie" | "png" | "unknown";

export type RuntimeSticker = {
  id: string;
  name: string;
  description: string | null;
  format: RuntimeStickerFormat;
  url: string;
  guildId: string | null;
};

type StickerSource = {
  id: string;
  name: string;
  description?: string | null;
  format?: number | string | null;
  url?: string | null;
  guildId?: string | null;
};

export function toRuntimeStickers(sources: readonly StickerSource[]): RuntimeSticker[] | undefined {
  const stickers = sources
    .map(toRuntimeSticker)
    .filter((sticker): sticker is RuntimeSticker => sticker !== null)
    .sort((left, right) => left.id.localeCompare(right.id, "ja"));

  return stickers.length > 0 ? stickers : undefined;
}

function toRuntimeSticker(source: StickerSource): RuntimeSticker | null {
  const id = source.id.trim();
  const name = source.name.trim();
  if (!id || !name) {
    return null;
  }

  const format = normalizeStickerFormat(source.format);
  const url = normalizeStickerUrl({
    format,
    id,
    url: source.url,
  });

  return {
    description: normalizeNullableString(source.description),
    format,
    guildId: normalizeNullableString(source.guildId),
    id,
    name,
    url,
  };
}

function normalizeStickerFormat(format: number | string | null | undefined): RuntimeStickerFormat {
  if (format === 1) {
    return "png";
  }
  if (format === 2) {
    return "apng";
  }
  if (format === 3) {
    return "lottie";
  }
  if (format === 4) {
    return "gif";
  }
  if (typeof format === "string") {
    const normalized = format.trim().toLowerCase();
    if (
      normalized === "png" ||
      normalized === "apng" ||
      normalized === "lottie" ||
      normalized === "gif"
    ) {
      return normalized;
    }
  }

  return "unknown";
}

function normalizeStickerUrl(input: {
  format: RuntimeStickerFormat;
  id: string;
  url?: string | null;
}): string {
  const url = input.url?.trim();
  if (url) {
    return url;
  }

  return `https://media.discordapp.net/stickers/${input.id}.${toStickerUrlExtension(input.format)}`;
}

function toStickerUrlExtension(format: RuntimeStickerFormat): string {
  if (format === "gif") {
    return "gif";
  }
  if (format === "lottie") {
    return "json";
  }

  return "png";
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
