# DSHプラグイン開発用の指示とSkills

DSH公式のプラグイン開発用4種と、本体開発用15種を、独立したプラグインリポジトリで使うために調整しました。日本語の指示、対象版の確認、公開物の導入、更新後の反映、他プラグインとの共存を扱います。

共通ルールは [AGENTS.md](AGENTS.md) にあります。公式の確認版、変更方針、ライセンスは [NOTICE.md](NOTICE.md) に記載しています。このSkill集自体はDSHの実行プラグインではありません。

## プラグイン開発用

| Skill | 使う作業 |
| --- | --- |
| [cordis-plugin-development](skills/cordis-plugin-development/SKILL.md) | Host・UI・MCPの設計、実装、導入、配布、更新、解除 |
| [cordis-composition-reference](skills/cordis-composition-reference/SKILL.md) | bundle patch、Loaderの設定、依存・scope・isolateの確認 |
| [editing-cordis-compositions](skills/editing-cordis-compositions/SKILL.md) | プリセットの作成・変更と、Host/presetへの配置 |
| [agent-experience](skills/agent-experience/SKILL.md) | ツールの名前・説明・schema、情報の発見とcontext量 |

## 本体開発用から調整したもの

| Skill | 使う作業 |
| --- | --- |
| [dsh-code-review](skills/dsh-code-review/SKILL.md) | PR・差分のレビューと、根拠のある指摘 |
| [dsh-client-ui-ux](skills/dsh-client-ui-ux/SKILL.md) | DSHに合わせた画面、設定パネル、メニュー、操作状態 |
| [dsh-error-handling](skills/dsh-error-handling/SKILL.md) | 部分失敗、結果不明、取消、復旧、エラー表示 |
| [dsh-pre-push-checks](skills/dsh-pre-push-checks/SKILL.md) | 差分に合うローカル検証の選択と報告 |
| [dsh-ci-test-reliability](skills/dsh-ci-test-reliability/SKILL.md) | 並行実行、clock、port、process、解除で不安定になるテスト |
| [dsh-doc](skills/dsh-doc/SKILL.md) | README、導入手順、設定・互換性・公開資料 |
| [dsh-prose-standard](skills/dsh-prose-standard/SKILL.md) | 文書・コメント・UI文言の正確さと読みやすさ |
| [dsh-trim-cot-leakage](skills/dsh-trim-cot-leakage/SKILL.md) | 作業中の語り、非公開の参照、レビュー会話の残骸の整理 |
| [dsh-translate-docs](skills/dsh-translate-docs/SKILL.md) | 依頼された言語への翻訳と既存の翻訳の更新 |
| [dsh-create-upgrade-guide](skills/dsh-create-upgrade-guide/SKILL.md) | 利用者に見える破壊的変更の移行案内 |
| [dsh-find-simplifications](skills/dsh-find-simplifications/SKILL.md) | 不要な実装・設定・依存を、利用経路を確認して削減 |
| [dsh-speed-up-perf](skills/dsh-speed-up-perf/SKILL.md) | 実際の利用経路の計測と性能改善 |
| [dsh-archive-agent-notes](skills/dsh-archive-agent-notes/SKILL.md) | 既存の設計記録の統合・保存・整理 |
| [dsh-merging-stacked-prs](skills/dsh-merging-stacked-prs/SKILL.md) | 依存関係のあるPRの検証・順序・マージ |
| [record-browser-gif](skills/record-browser-gif/SKILL.md) | 依頼されたUI操作の録画・GIF作成 |

## 別のリポジトリへ持ち込む

必要な `skills/<名前>/` を、対象リポジトリの `.agents/skills/<名前>/` へディレクトリごとコピーします。各Skillの `LICENSE` と、同梱されている `references/` も残します。Skill本文は隣のSkillや、このリポジトリの相対pathに依存しません。

共通ルールを使う場合は、このディレクトリの `AGENTS.md`・`LICENSE`・`NOTICE.md`・`upstream.json` も `.agents/` へコピーし、対象リポジトリのルート `AGENTS.md` に読込先を追記します。既存のファイルや指示へ統合する際は、対象のブランチ・remote・検証コマンドを維持します。

```markdown
DSHプラグインの実装・レビューでは `.agents/AGENTS.md` を読み、対象作業に合う `.agents/skills/` のSkillを使います。
```

たとえば実装時は `cordis-plugin-development`、画面変更時は `dsh-client-ui-ux`、公開前は `dsh-pre-push-checks` を選びます。19種を毎回まとめて読み込む必要はありません。実作業のAPI・コマンドは対象リポジトリで確認します。

各Skillには `name`、`description`、`license` のfrontmatterがあります。`$cordis-plugin-development` のような呼出し方法や自動検出の可否は、使う開発エージェントに従います。DSH内でのlive inspectionと、Codexでのソース調査の両方を想定しています。
