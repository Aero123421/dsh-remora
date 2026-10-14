# 公式からの調整とライセンス

このディレクトリの共通ルールとSkillsは、公開されているDeepSeek Harnessの開発資料を基に、独立したDSHプラグイン向けに調整したものです。公式版そのものではありません。

## 確認した公式ソース

- リポジトリ: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- commit: `d743267388641bc76f17c45ce8b4c231aed1d32c`、DSH `0.2.1-alpha.2`
- プラグイン用: [agent-preset/skills](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/preset/agent-preset/skills)
- 本体開発用: [.agents/skills](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/.agents/skills)
- 共通ルールの参照: [AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/AGENTS.md)、[packages/AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/AGENTS.md)、[Clientの指示](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/AGENTS.md)

2026-10-14（日本時間）に調整しました。19種の元file・blob SHAと、参照資料の対応を [upstream.json](upstream.json) に保存しています。公式の `.agents/skills/agent-experience/SKILL.md` は製品内の同名Skillへのsymlinkなので、ここでは実体を一つだけ同梱しています。

## 調整した内容

- 日本語の手順にし、対象DSHと独立pluginのAPI・manifest・CIを読む形にしました。
- DSH内のlive inspectionを使える場合と、Codex等でソースを読む場合を分けました。
- 本体専用の検証script、担当者指定の承認経路、GitHub stackの必須化、翻訳pair・hashの必須化を外しました。
- GIFは必要な操作の説明・確認に使い、全UI PRで実APIと録画を必須にする指示を外しました。
- 本リポジトリの公開調査を基に、GitHub/tarball配布、更新後の反映、操作の結果照合、共存・解除を追加しました。
- Skillごとに読込める範囲を限定し、参照資料はそのSkillのディレクトリへ同梱しました。

上流を更新するときは、対応fileの差分と引用APIを読み、対象DSHで確認します。上流の指示を機械的に上書きせず、独立pluginへの調整と既存のユーザー指示を維持します。参照元の版を更新したことと、全runtimeを試験したことを分けて記録します。

## ライセンスの保持

公式資料は [MIT License](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/LICENSE) です。DeepSeekの著作権表示と許諾文を [.agentsのLICENSE](LICENSE) と各Skillの `LICENSE` に保持しています。

別のリポジトリへ持ち込むときも、必要な参照資料とLICENSEを一緒にコピーします。共通ルールをコピーする場合は、このNOTICEと対応するLICENSEも残します。
