import { describe, expect, it } from "vitest";

import { toRuntimeStickers } from "./runtime-sticker";

describe("toRuntimeStickers", () => {
  it("Discordステッカー形式を安定した文字列へ正規化する", () => {
    expect(
      toRuntimeStickers([
        {
          format: 1,
          id: "sticker-png",
          name: "png",
        },
        {
          format: 2,
          id: "sticker-apng",
          name: "apng",
        },
        {
          format: 3,
          id: "sticker-lottie",
          name: "lottie",
        },
        {
          format: 4,
          id: "sticker-gif",
          name: "gif",
        },
      ]),
    ).toEqual([
      {
        description: null,
        format: "apng",
        guildId: null,
        id: "sticker-apng",
        name: "apng",
        url: "https://media.discordapp.net/stickers/sticker-apng.png",
      },
      {
        description: null,
        format: "gif",
        guildId: null,
        id: "sticker-gif",
        name: "gif",
        url: "https://media.discordapp.net/stickers/sticker-gif.gif",
      },
      {
        description: null,
        format: "lottie",
        guildId: null,
        id: "sticker-lottie",
        name: "lottie",
        url: "https://media.discordapp.net/stickers/sticker-lottie.json",
      },
      {
        description: null,
        format: "png",
        guildId: null,
        id: "sticker-png",
        name: "png",
        url: "https://media.discordapp.net/stickers/sticker-png.png",
      },
    ]);
  });
});
