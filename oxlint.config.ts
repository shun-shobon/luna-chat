import { shun_shobon } from "@shun-shobon/oxlint-config";

export default shun_shobon(
  {},
  {
    overrides: [
      {
        // tsconfig の対象外で型情報がなく、すべての値が error 型として扱われるため
        files: ["scripts/**/*.mjs"],
        rules: {
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-member-access": "off",
        },
      },
      {
        files: ["**/src/modules/*/application/**/*.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["**/adapters/**"],
                  message: "application層からadapters層へ直接依存しないこと。",
                },
                {
                  group: ["**/application/**"],
                  message: "他モジュールのapplication層へ直接依存しないこと。",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["**/src/modules/*/ports/**/*.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["**/adapters/**"],
                  message: "ports層からadapters層へ直接依存しないこと。",
                },
                {
                  group: ["**/inbound/**"],
                  message: "ports層からinbound層へ直接依存しないこと。",
                },
                {
                  group: ["**/application/**"],
                  message: "ports層からapplication層へ直接依存しないこと。",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["**/src/modules/*/domain/**/*.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["**/adapters/**"],
                  message: "domain層からadapters層へ直接依存しないこと。",
                },
                {
                  group: ["**/inbound/**"],
                  message: "domain層からinbound層へ直接依存しないこと。",
                },
                {
                  group: ["**/application/**"],
                  message: "domain層からapplication層へ直接依存しないこと。",
                },
                {
                  group: ["**/ports/**"],
                  message: "domain層からports層へ直接依存しないこと。",
                },
              ],
            },
          ],
        },
      },
    ],
  },
);
