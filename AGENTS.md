# Repository workflow

このfileは作業規約であり、製品仕様の正本ではない。製品の外部契約は`docs/SPEC.md`、内部設計は`docs/ARCHITECTURE.md`を参照する。実装後はsource、SPEC、ARCHITECTUREを同じ変更で同期する。

## Communication

- 利用者への返答、commit subject、commit bodyは日本語で書く。
- 不明な製品判断は実装で補わず、利用者へ確認する。
- 根拠のない曖昧な選択肢を並べず、確認済みの事実と制約から推奨を示す。

## Design

- modular hexagonal architecture、SOLID、DDDをproject規模に合わせて適用する。
- YAGNI、KISS、DRYを優先する。
- compatibility behavior、alias、silent fallback、default-value fallbackを追加しない。SPECで明示されたfallbackとdefaultだけを実装する。
- module間はapplication portを直接`await`し、内部event busとDI frameworkを導入しない。
- `shared`へ機能固有型を置かない。

## Type safety

- 未検証のenvironment、TOML、JSON、SDK/API responseに`as`を使わない。
- `as unknown as`と`as any`を禁止する。
- Codex generated discriminated union、Zod、type guardを使い、外部境界でruntime validationする。
- 完全に自前で構築した送信payloadへの局所的な型補助だけを例外とする。

## Tests

- global coverage率ではなく、全状態遷移と各外部境界のsuccess、timeout、不正response、exceptionを契約testにする。
- snapshotは固定developer instructionsと入力JSON組立だけに使う。
- 実Discord・実CodexはREADMEのmanual live E2Eで確認する。

## Commands

```sh
pnpm run gen
pnpm run format:check
pnpm run lint
pnpm run knip
pnpm run typecheck
pnpm run test
pnpm run build
docker compose build
```

sourceを変更したら、commit前に関連testと全quality gateを通す。実装完了時はlocal Docker buildも通す。

## Git

- Conventional Commitsの`<type>: <日本語summary>`を使う。
- 3行目以降のbodyへ具体的な変更を書く。
- 一commit一目的とし、文書、基盤、capability、cutover、旧実装削除を分ける。
- GPG署名を無効化しない。署名失敗時は利用者へ報告する。
- userの既存変更を上書き、reset、checkoutしない。
